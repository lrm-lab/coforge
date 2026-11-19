import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  REMINDER_TRIGGER_CALLS_PER_MINUTE,
  REMINDER_TRIGGER_KEYS_PER_AGENT,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  pruneReminderTriggerEvents,
  recordReminderTrigger,
  type RecordReminderTriggerInput,
} from "#src/server/db/repositories/reminder-trigger.repositories.server";
import { ReminderRefusal } from "#src/server/reminders/reminders.server";

const connectionString = Bun.env.REMINDER_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("REMINDER_TEST_DATABASE_URL is required (isolated PostgreSQL)");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const t0 = new Date("2026-09-08T12:00:00.000Z");
const minutes = (count: number) => new Date(t0.getTime() + count * 60_000);
const fixture = {} as { workspaceId: string; agentId: string; computerId: string; userId: string };
let sequence = 0;

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `trigger_${suffix}`, username: `trigger_${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `trigger-${suffix}`,
      name: "Trigger integration",
      members: { create: { userId: user.id } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "helper",
      displayName: "Helper",
      runtimeConfig: {},
    },
  });
  Object.assign(fixture, {
    workspaceId: workspace.id,
    agentId: agent.id,
    computerId: computer.id,
    userId: user.id,
  });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.computer.deleteMany({ where: { ownerId: fixture.userId } });
  await db.user.deleteMany({ where: { id: fixture.userId } });
  await db.$disconnect();
});

function trigger(overrides: Partial<RecordReminderTriggerInput> = {}) {
  sequence += 1;
  return recordReminderTrigger(
    db,
    { workspaceId: fixture.workspaceId, agentId: fixture.agentId, computerId: fixture.computerId },
    {
      key: "ci.red",
      level: "wake",
      mergeWindowSeconds: 600,
      title: "CI is red",
      requestId: `request-${sequence}`,
      now: t0,
      deliverWake: true,
      ...overrides,
    },
  );
}

async function reset() {
  await db.reminderTriggerEvent.deleteMany({ where: { workspaceId: fixture.workspaceId } });
  await db.reminderTrigger.deleteMany({ where: { workspaceId: fixture.workspaceId } });
  await db.reminder.deleteMany({ where: { workspaceId: fixture.workspaceId } });
}

test("the first wake call wakes, merges the rest of the window, then wakes again", async () => {
  await reset();
  const first = await trigger({ details: "3 jobs failed" });
  expect(first.outcome).toBe("woke");
  const reminder = await db.reminder.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, kind: "trigger" },
  });
  expect(reminder).toMatchObject({
    triggerKey: "ci.red",
    messageId: null,
    status: "scheduled",
    details: "3 jobs failed",
    title: "CI is red",
    ownerAgentId: fixture.agentId,
  });
  expect(reminder.target).toBe(`reminder:${reminder.id}`);
  expect(reminder.fireAt).toEqual(t0);

  const merged = await trigger({ now: minutes(2) });
  expect(merged.outcome).toBe("merged");
  expect(merged.receipt.triggerCount).toBe(1);
  expect(await db.reminder.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);

  const later = await trigger({ now: minutes(11) });
  expect(later.outcome).toBe("woke");
  expect(later.receipt.triggerCount).toBe(2);
  expect(await db.reminder.count({ where: { workspaceId: fixture.workspaceId } })).toBe(2);
});

test("a log-level key, or a Computer that cannot take the wake, only records", async () => {
  await reset();
  expect((await trigger({ level: "log" })).outcome).toBe("recorded");
  expect((await trigger({ key: "other", deliverWake: false })).outcome).toBe("recorded");
  expect(await db.reminder.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0);
});

test("a replayed request ID returns the same receipt and adds nothing", async () => {
  await reset();
  const first = await trigger({ requestId: "same" });
  const replay = await trigger({ requestId: "same", now: minutes(5) });
  expect(replay).toEqual(first);
  expect(await db.reminderTriggerEvent.count({ where: { workspaceId: fixture.workspaceId } })).toBe(
    1,
  );
  expect(await db.reminder.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);
});

test("concurrent calls for one key serialize on the row: one wakes, the rest merge", async () => {
  await reset();
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () => trigger({ now: minutes(1) }).then((result) => result.outcome)),
  );
  expect(outcomes.filter((outcome) => outcome === "woke")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === "merged")).toHaveLength(7);
  expect(await db.reminder.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);
});

test("the sixth wake in an hour is allowed and the seventh throttles", async () => {
  await reset();
  const outcomes: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    outcomes.push((await trigger({ mergeWindowSeconds: 60, now: minutes(index * 2) })).outcome);
  }
  expect(outcomes).toEqual(["woke", "woke", "woke", "woke", "woke", "woke", "throttled"]);
});

test("concurrent calls creating different keys never pass the per-Agent key limit", async () => {
  await reset();
  const settled = (from: number, to: number) =>
    Promise.allSettled(
      Array.from({ length: to - from }, (_, offset) =>
        trigger({ key: `key.${from + offset}`, level: "log", now: minutes(from + offset) }),
      ),
    );
  const results: PromiseSettledResult<unknown>[] = [];
  const nearLimit = REMINDER_TRIGGER_KEYS_PER_AGENT - 5;
  for (let start = 0; start < nearLimit; start += 8)
    results.push(...(await settled(start, Math.min(start + 8, nearLimit))));
  results.push(...(await settled(nearLimit, nearLimit + 17)));
  const refused = results.filter(
    (result) => result.status === "rejected" && result.reason instanceof ReminderRefusal,
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
    REMINDER_TRIGGER_KEYS_PER_AGENT,
  );
  expect(refused).toHaveLength(12);
  expect(await db.reminderTrigger.count({ where: { workspaceId: fixture.workspaceId } })).toBe(
    REMINDER_TRIGGER_KEYS_PER_AGENT,
  );
});

test("more than sixty calls in a minute are refused as rate limited", async () => {
  await reset();
  for (let index = 0; index < REMINDER_TRIGGER_CALLS_PER_MINUTE; index += 1)
    await trigger({ level: "log", now: new Date(t0.getTime() + index * 500) });
  const refusal = await trigger({ level: "log", now: new Date(t0.getTime() + 31_000) }).catch(
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(ReminderRefusal);
  expect((refusal as ReminderRefusal).code).toBe("RATE_LIMITED");
  expect((await trigger({ level: "log", now: minutes(2) })).outcome).toBe("recorded");
});

test("pruning removes events older than seven days and trims a key to its newest 1000 without touching the last hour", async () => {
  await reset();
  const row = await db.reminderTrigger.create({
    data: {
      workspaceId: fixture.workspaceId,
      ownerAgentId: fixture.agentId,
      key: "prune",
      level: "log",
      mergeWindowSeconds: 600,
    },
  });
  const now = new Date("2026-09-20T12:00:00.000Z");
  const event = (at: Date, outcome: string, index: number) => ({
    triggerId: row.id,
    workspaceId: fixture.workspaceId,
    ownerAgentId: fixture.agentId,
    at,
    level: "log",
    outcome,
    title: "t",
    requestId: `prune-${index}`,
    triggerCount: 1,
    firstTriggeredAt: at,
    lastTriggeredAt: at,
  });
  const old = new Date(now.getTime() - 8 * 86_400_000);
  const aged = Array.from({ length: 1005 }, (_, index) =>
    event(new Date(now.getTime() - 2 * 3_600_000 - index * 1000), "merged", index),
  );
  const recent = Array.from({ length: 5 }, (_, index) =>
    event(new Date(now.getTime() - 60_000 - index), "woke", 2000 + index),
  );
  await db.reminderTriggerEvent.createMany({
    data: [event(old, "merged", 3000), ...aged, ...recent],
  });
  await pruneReminderTriggerEvents(db, now);
  const kept = await db.reminderTriggerEvent.findMany({
    where: { triggerId: row.id },
    orderBy: { at: "desc" },
  });
  expect(kept).toHaveLength(1000);
  expect(kept.filter((kept) => kept.outcome === "woke")).toHaveLength(5);
  expect(kept.some((kept) => kept.at.getTime() === old.getTime())).toBe(false);
});

test("the hourly wake cap holds across keys: with five wakes spent, concurrent calls on other keys wake once", async () => {
  await reset();
  for (let index = 0; index < 5; index += 1)
    await trigger({ key: `spent.${index}`, now: minutes(index) });
  for (let index = 0; index < 10; index += 1)
    await trigger({ key: `racing.${index}`, level: "log", now: minutes(5) });
  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      trigger({ key: `racing.${index}`, now: minutes(10) }).then((result) => result.outcome),
    ),
  );
  expect(outcomes.filter((outcome) => outcome === "woke")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === "throttled")).toHaveLength(9);
});

test("a log call records an event and leaves the key row exactly as it was", async () => {
  await reset();
  await trigger({ mergeWindowSeconds: 600 });
  await trigger({ now: minutes(1), requestId: "merged" });
  const before = await db.reminderTrigger.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, key: "ci.red" },
  });
  expect(before.pendingCount).toBe(1);

  const logged = await trigger({ level: "log", mergeWindowSeconds: 3600, now: minutes(2) });
  expect(logged.outcome).toBe("recorded");
  const after = await db.reminderTrigger.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, key: "ci.red" },
  });
  expect(after).toEqual(before);
  expect(
    await db.reminderTriggerEvent.count({ where: { triggerId: before.id, outcome: "recorded" } }),
  ).toBe(1);
});

test("a wake call changes the window parameters only when it starts a new window", async () => {
  await reset();
  await trigger({ mergeWindowSeconds: 600 });
  await trigger({ mergeWindowSeconds: 3600, now: minutes(1), requestId: "merged" });
  const merged = await db.reminderTrigger.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, key: "ci.red" },
  });
  expect(merged.mergeWindowSeconds).toBe(600);
  await trigger({ mergeWindowSeconds: 3600, now: minutes(11) });
  const woke = await db.reminderTrigger.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, key: "ci.red" },
  });
  expect(woke.mergeWindowSeconds).toBe(3600);
});
