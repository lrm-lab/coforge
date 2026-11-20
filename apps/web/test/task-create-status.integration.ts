import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * A create may open the new Task in a chosen column (task #61): the board's form sends the
 * column it was opened from. The defaults stay — without a status a self-assign starts in
 * progress and anything else waits in todo — and an explicit status only says where the new
 * Task waits instead: a self-assign parked elsewhere is held, not started (no claimed time, no
 * execution session), and one opened where a Task needs a hand is refused without one.
 */
const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

const short = crypto.randomUUID().slice(0, 8);
const ada = await db.user.create({
  data: { displayName: `create-status-ada-${short}`, username: `create-status-ada-${short}` },
});
const workspace = await db.workspace.create({
  data: {
    slug: `create-status-${short}`,
    name: "Create status",
    members: { create: { userId: ada.id, role: "owner" } },
  },
});
cleanup.push(
  () => db.user.delete({ where: { id: ada.id } }),
  () => db.workspace.delete({ where: { id: workspace.id } }),
);
const channel = await db.conversation.create({
  data: {
    workspaceId: workspace.id,
    channelName: `create-status-${short}`,
    members: { create: { userId: ada.id } },
  },
});
const board = new TaskBoard(db);
const run = (command: Record<string, unknown>) =>
  board.execute({ workspaceId: workspace.id, userId: ada.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    ...command,
  } as Parameters<TaskBoard["execute"]>[1]);

test("a create opens the Task in backlog, todo, or in_progress", async () => {
  const [backlog] = (
    await run({
      operation: "create",
      title: "Parked idea",
      assignee: `@${ada.username}`,
      status: "backlog",
    })
  ).tasks;
  expect(backlog).toMatchObject({ status: "backlog" });
  const row = await db.task.findUniqueOrThrow({ where: { id: backlog!.id } });
  expect(row.claimedAt).toBeNull();

  const [inProgress] = (
    await run({ operation: "create", title: "Ownerless active", status: "in_progress" })
  ).tasks;
  expect(inProgress).toMatchObject({ status: "in_progress", owner: null });
});

test("a create refuses non-create statuses such as in_review, done, and closed", async () => {
  for (const status of ["in_review", "done", "closed"]) {
    await expect(
      run({ operation: "create", title: `Bad ${status}`, status }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
});

test("the defaults stay: a self-assign starts, an assigneeless create waits in todo", async () => {
  const [selfAssigned] = (
    await run({ operation: "create", title: "Mine", assignee: `@${ada.username}` })
  ).tasks;
  const row = await db.task.findUniqueOrThrow({ where: { id: selfAssigned!.id } });
  expect(row).toMatchObject({ status: "in_progress" });
  expect(row.claimedAt).not.toBeNull();
  const [plain] = (await run({ operation: "create", title: "Plain" })).tasks;
  expect(plain).toMatchObject({ status: "todo" });
});

test("a self-assign parked elsewhere is held, not started", async () => {
  const [parked] = (
    await run({
      operation: "create",
      title: "Parked",
      assignee: `@${ada.username}`,
      status: "todo",
    })
  ).tasks;
  expect(parked).toMatchObject({ status: "todo" });
  const row = await db.task.findUniqueOrThrow({ where: { id: parked!.id } });
  expect(row.claimedAt).toBeNull();
});
