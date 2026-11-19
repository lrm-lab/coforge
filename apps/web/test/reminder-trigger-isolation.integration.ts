import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { REMINDER_DUE_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaReminderDueRepository } from "#src/server/db/repositories/reminder-due.repositories.server";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";

const connectionString = Bun.env.REMINDER_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("REMINDER_TEST_DATABASE_URL is required (isolated PostgreSQL)");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const fixture = {} as { workspaceId: string; agentId: string; computerId: string; userId: string };
const now = new Date("2026-09-08T12:00:00.000Z");

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `iso_${suffix}`, username: `iso_${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: `iso-${suffix}`, name: "Isolation", members: { create: { userId: user.id } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  await db.workspaceComputer.update({
    where: { workspaceId_computerId: { workspaceId: workspace.id, computerId: computer.id } },
    data: { readyCapabilities: [REMINDER_DUE_CAPABILITY] },
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

test("a trigger reminder is invisible to the scheduled-reminder reads and never claimed as a v1 due", async () => {
  const base = {
    workspaceId: fixture.workspaceId,
    ownerAgentId: fixture.agentId,
    computerId: fixture.computerId,
    fireAt: new Date(now.getTime() - 1000),
  };
  const scheduled = await db.reminder.create({
    data: { ...base, title: "plain", target: "#general", messageId: crypto.randomUUID() },
  });
  const trigger = await db.reminder.create({
    data: {
      ...base,
      title: "trigger",
      target: `reminder:${Bun.randomUUIDv7()}`,
      kind: "trigger",
      triggerKey: "ci.red",
      details: "3 jobs",
    },
  });
  const scope = {
    workspaceId: fixture.workspaceId,
    computerId: fixture.computerId,
    agentId: fixture.agentId,
    userId: fixture.userId,
  };
  const repository = new PrismaReminderRepository(db);
  expect((await repository.list(scope, undefined, true)).map((item) => item.reminderId)).toEqual([
    scheduled.id,
  ]);
  expect(await repository.get(scope, trigger.id)).toBeUndefined();
  expect(await repository.get(scope, scheduled.id)).toBeDefined();

  await new PrismaReminderDueRepository(db).claim(now);
  const occurrences = await db.reminderOccurrence.findMany({
    where: { workspaceId: fixture.workspaceId },
  });
  expect(occurrences.map((occurrence) => occurrence.reminderId)).toEqual([scheduled.id]);
});

test("trigger reminders do not use up the active scheduled-reminder limit", async () => {
  const scope = {
    workspaceId: fixture.workspaceId,
    computerId: fixture.computerId,
    agentId: fixture.agentId,
    userId: fixture.userId,
  };
  await db.reminder.deleteMany({ where: { workspaceId: fixture.workspaceId } });
  await db.reminder.createMany({
    data: Array.from({ length: 60 }, (_, index) => ({
      workspaceId: fixture.workspaceId,
      ownerAgentId: fixture.agentId,
      computerId: fixture.computerId,
      title: `trigger ${index}`,
      target: `reminder:${Bun.randomUUIDv7()}`,
      kind: "trigger",
      triggerKey: `key.${index}`,
      fireAt: new Date("2027-01-01T00:00:00.000Z"),
    })),
  });
  const created = await new PrismaReminderRepository(db).create(scope, "limit-1", "fp", {
    ownerAgentId: fixture.agentId,
    computerId: fixture.computerId,
    version: 1,
    title: "plain",
    target: "#general",
    messageId: crypto.randomUUID(),
    fireAt: "2027-01-01T00:00:00.000Z",
    status: "scheduled",
  });
  expect(created.title).toBe("plain");
});
