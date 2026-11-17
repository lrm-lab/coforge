import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaReminderDueRepository } from "#src/server/db/repositories/reminder-due.repositories.server";
import { REMINDER_DUE_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";

const connectionString = Bun.env.REMINDER_TEST_DATABASE_URL;
if (!connectionString) throw new Error("REMINDER_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = new PrismaReminderDueRepository(db);
const now = new Date("2026-11-17T01:00:00.000Z");
let userId: string;
let workspaceId: string;
let computerId: string;
let agentId: string;

beforeAll(async () => {
  const suffix = crypto.randomUUID();
  const user = await db.user.create({
    data: { username: `due_${suffix.slice(0, 8)}`, displayName: "Due test" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `due-${suffix}`, name: "Due", members: { create: { userId } } },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId: userId, machineId: suffix, workspaces: { create: { workspaceId } } },
  });
  computerId = computer.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      computerId,
      name: "due",
      displayName: "Due",
      runtimeConfig: {},
    },
  });
  agentId = agent.id;
});

afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.computer.deleteMany({ where: { ownerId: userId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

function createReminder(fireAt = new Date(now.getTime() - 1_000), repeat?: string) {
  return db.reminder.create({
    data: {
      workspaceId,
      computerId,
      ownerAgentId: agentId,
      title: "Due",
      target: "#general",
      messageId: crypto.randomUUID(),
      fireAt,
      repeat,
      ...(repeat ? { timezone: "UTC" } : {}),
    },
  });
}

test("legacy Computer stays untouched; first capable ready claims overdue exactly once", async () => {
  const reminder = await createReminder();
  await repository.claim(now);
  expect(await db.reminderOccurrence.count({ where: { reminderId: reminder.id } })).toBe(0);
  expect((await db.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).version).toBe(1);
  await repository.record(workspaceId, computerId, [REMINDER_DUE_CAPABILITY], {
    workerInstanceId: "new",
    startedAt: 1,
  });
  await Promise.all([repository.claim(now), repository.claim(now)]);
  expect(await db.reminderOccurrence.count({ where: { reminderId: reminder.id } })).toBe(1);
  expect(await db.reminderEvent.count({ where: { reminderId: reminder.id, type: "fired" } })).toBe(
    1,
  );
  expect((await db.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).status).toBe(
    "fired",
  );
});

test("transport ACK is revision and scope bound, and replays idempotently", async () => {
  const reminder = await createReminder();
  await repository.claim(now);
  const due = (await repository.pending(now)).find((item) => item.job.reminderId === reminder.id)!;
  expect(due).toBeDefined();
  const ack = {
    protocolMajor: 1,
    requestId: "ack",
    workspaceId,
    computerId,
    agentId,
    occurrenceId: due.occurrenceId,
    reminderId: reminder.id,
    version: 1,
  };
  expect(await repository.acknowledge({ ...ack, version: 2 }, now)).toBe(false);
  expect(await repository.acknowledge({ ...ack, computerId: crypto.randomUUID() }, now)).toBe(
    false,
  );
  expect(await repository.acknowledge(ack, now)).toBe(true);
  expect(await repository.acknowledge(ack, now)).toBe(true);
  expect(
    (await repository.pending(now)).some((item) => item.occurrenceId === due.occurrenceId),
  ).toBe(false);
});

test("new and legacy Computers coexist without the worker advancing the legacy plan", async () => {
  const legacy = await db.computer.create({
    data: {
      ownerId: userId,
      machineId: crypto.randomUUID(),
      workspaces: { create: { workspaceId } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      computerId: legacy.id,
      name: "legacy",
      displayName: "Legacy",
      runtimeConfig: {},
    },
  });
  const reminder = await db.reminder.create({
    data: {
      workspaceId,
      computerId: legacy.id,
      ownerAgentId: agent.id,
      title: "Legacy",
      target: "#general",
      messageId: crypto.randomUUID(),
      fireAt: new Date(now.getTime() - 1_000),
    },
  });
  await repository.claim(now);
  expect(await db.reminderOccurrence.count({ where: { reminderId: reminder.id } })).toBe(0);
  const fired = await new PrismaReminderRepository(db).fire(
    { workspaceId, computerId: legacy.id, agentId: agent.id, userId },
    {
      protocolMajor: 1,
      workspaceId,
      computerId: legacy.id,
      agentId: agent.id,
      requestId: crypto.randomUUID(),
      reminderId: reminder.id,
      version: 1,
      firedAtClient: now.toISOString(),
    },
    now,
  );
  expect(fired.result.fired).toBe(true);
});

test("only the latest undelivered recurrence remains pending", async () => {
  const reminder = await createReminder(new Date(now.getTime() - 60_000), "every:1m");
  await repository.claim(now);
  await repository.claim(new Date(now.getTime() + 120_000));
  const rows = await db.reminderOccurrence.findMany({
    where: { reminderId: reminder.id },
    orderBy: { version: "asc" },
  });
  expect(rows.map((row) => row.status)).toEqual(["superseded", "pending"]);
});

test("legacy fire racing first server claim advances and fires exactly once", async () => {
  const reminder = await createReminder();
  const [legacy] = await Promise.all([
    new PrismaReminderRepository(db).fire(
      { workspaceId, computerId, agentId, userId },
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId,
        computerId,
        agentId,
        reminderId: reminder.id,
        version: 1,
        firedAtClient: now.toISOString(),
      },
      now,
    ),
    repository.claim(now),
  ]);
  const occurrences = await db.reminderOccurrence.count({ where: { reminderId: reminder.id } });
  expect(Number(legacy.result.fired) + occurrences).toBe(1);
  expect(await db.reminderEvent.count({ where: { reminderId: reminder.id, type: "fired" } })).toBe(
    1,
  );
});

test("user acknowledgement resolves the occurrence revision after transport ACK", async () => {
  const reminder = await createReminder();
  await repository.claim(now);
  const due = (await repository.pending(now)).find((item) => item.job.reminderId === reminder.id)!;
  expect(due).toBeDefined();
  const original = new PrismaReminderRepository(db);
  const scope = { workspaceId, computerId, agentId, userId };
  await expect(
    original.acknowledge(scope, "early", "early", reminder.id, 1, "acknowledged", now),
  ).rejects.toThrow("not delivered");
  await repository.acknowledge(
    {
      protocolMajor: 1,
      requestId: "transport",
      workspaceId,
      computerId,
      agentId,
      occurrenceId: due.occurrenceId,
      reminderId: reminder.id,
      version: 1,
    },
    now,
  );
  await original.acknowledge(scope, "user", "user", reminder.id, 1, "acknowledged", now);
  await original.acknowledge(
    scope,
    "user-retry",
    "user-retry",
    reminder.id,
    1,
    "acknowledged",
    now,
  );
  expect(
    await db.reminderEvent.count({ where: { reminderId: reminder.id, type: "acknowledged" } }),
  ).toBe(1);
});

test("pending retry batches do not starve later occurrences behind offline Computers", async () => {
  const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
  await db.reminder.createMany({
    data: ids.map((id) => ({
      id,
      workspaceId,
      computerId,
      ownerAgentId: agentId,
      title: "Batch",
      target: "#general",
      messageId: crypto.randomUUID(),
      fireAt: new Date(now.getTime() - 1_000),
    })),
  });
  await repository.claim(now);
  await repository.claim(now);
  const batches = [...(await repository.pending(now)), ...(await repository.pending(now))];
  const seen = new Set(batches.map((due) => due.job.reminderId));
  expect(ids.every((id) => seen.has(id))).toBe(true);
});

test("orphaned schedules cannot occupy the entire claim batch", async () => {
  const deleted = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      computerId,
      name: "deleted",
      displayName: "Deleted",
      runtimeConfig: {},
      deletedAt: now,
    },
  });
  await db.reminder.createMany({
    data: Array.from({ length: 100 }, () => ({
      workspaceId,
      computerId,
      ownerAgentId: deleted.id,
      title: "Orphan",
      target: "#general",
      messageId: crypto.randomUUID(),
      fireAt: new Date(now.getTime() - 86_400_000),
    })),
  });
  const live = await createReminder();
  await repository.claim(now);
  expect(await db.reminderOccurrence.count({ where: { reminderId: live.id } })).toBe(1);
});

test("expiry and capability downgrade report each lost occurrence once", async () => {
  const reminder = await createReminder(new Date(now.getTime() - 8 * 86_400_000));
  await repository.claim(now);
  const first = await repository.expire(now);
  expect(first.some((item) => item.job.reminderId === reminder.id)).toBe(true);
  expect((await repository.expire(now)).some((item) => item.job.reminderId === reminder.id)).toBe(
    false,
  );
  const pending = await createReminder();
  await repository.claim(now);
  await repository.record(workspaceId, computerId, [], {
    workerInstanceId: "rollback",
    startedAt: 2,
  });
  await repository.record(workspaceId, computerId, [REMINDER_DUE_CAPABILITY], {
    workerInstanceId: "upgrade-again",
    startedAt: 3,
  });
  expect((await repository.expire(now)).some((item) => item.job.reminderId === pending.id)).toBe(
    true,
  );
  expect((await repository.expire(now)).some((item) => item.job.reminderId === pending.id)).toBe(
    false,
  );
  await repository.record(workspaceId, computerId, [REMINDER_DUE_CAPABILITY], {
    workerInstanceId: "stale",
    startedAt: 1,
  });
  expect(
    (
      await db.workspaceComputer.findUniqueOrThrow({
        where: { workspaceId_computerId: { workspaceId, computerId } },
      })
    ).readyCapabilities,
  ).toEqual([REMINDER_DUE_CAPABILITY]);
});

test("legacy user confirmation remains bound to its occurrence after an upgrade and rollback", async () => {
  const reminder = await createReminder(new Date(now.getTime() - 60_000), "every:1m");
  const legacy = new PrismaReminderRepository(db);
  const scope = { workspaceId, computerId, agentId, userId };
  const fire = (version: number, time: Date) =>
    legacy.fire(
      scope,
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId,
        computerId,
        agentId,
        reminderId: reminder.id,
        version,
        firedAtClient: time.toISOString(),
      },
      time,
    );
  await repository.record(workspaceId, computerId, [], { workerInstanceId: "old", startedAt: 4 });
  expect((await fire(1, now)).result.fired).toBe(true);
  await repository.record(workspaceId, computerId, [REMINDER_DUE_CAPABILITY], {
    workerInstanceId: "upgraded",
    startedAt: 5,
  });
  await repository.claim(new Date(now.getTime() + 61_000));
  await repository.record(workspaceId, computerId, [], {
    workerInstanceId: "rolled-back",
    startedAt: 6,
  });
  expect((await fire(3, new Date(now.getTime() + 121_000))).result.fired).toBe(true);
  await legacy.acknowledge(
    scope,
    "legacy-third",
    "legacy-third",
    reminder.id,
    3,
    "acknowledged",
    new Date(now.getTime() + 122_000),
  );
  const acknowledged = await db.reminderEvent.findFirstOrThrow({
    where: { reminderId: reminder.id, type: "acknowledged" },
  });
  expect(acknowledged.scheduledFor.toISOString()).toBe(
    new Date(now.getTime() + 120_000).toISOString(),
  );
});
