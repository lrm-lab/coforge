import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId: string;
let channelName: string;
let sourceId: string;
let agent: { id: string; name: string };
const board = new TaskBoard(db);

const asAgent = () => ({ workspaceId, agentId: agent.id });
const run = (command: Record<string, unknown>) =>
  board.execute(asAgent(), {
    idempotencyKey: crypto.randomUUID(),
    target: `#${channelName}`,
    ...command,
  } as Parameters<TaskBoard["execute"]>[1]);
const started = async (title: string) =>
  (
    await run({
      operation: "create",
      messageId: sourceId,
      title,
      assignee: `@${agent.name}`,
    })
  ).tasks[0]!;

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `withdraw-owner-${suffix}`, displayName: "Owner" },
  });
  channelName = `withdraw-${suffix}`;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-withdraw-${suffix}`,
      name: "Task withdraw",
      members: { create: { userId: owner.id, role: "member" } },
      agents: {
        create: {
          name: `withdraw-agent-${suffix}`,
          displayName: "Agent",
          ownerId: owner.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  agent = workspace.agents[0]!;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName, members: { create: [{ agentId: agent.id }] } },
    include: { members: true },
  });
  const source = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      senderMemberId: channel.members[0]!.id,
      body: "work request",
      sequence: 1,
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

test("an Agent withdraws a task it started by mistake: back to todo, still its own", async () => {
  const task = await started("Started by mistake");
  expect(task.status).toBe("in_progress");
  const withdrawn = (await run({ operation: "update", number: task.number, status: "todo" }))
    .tasks[0]!;
  expect(withdrawn).toMatchObject({ status: "todo", owner: { kind: "agent" } });
});

test("releasing the assignee keeps the task's current status", async () => {
  const inProgress = await started("Release while in progress");
  const released = (await run({ operation: "unclaim", number: inProgress.number })).tasks[0]!;
  expect(released).toMatchObject({ status: "in_progress", owner: null, claimedAt: null });

  const parked = await started("Unassign while in backlog");
  await run({ operation: "update", number: parked.number, status: "backlog" });
  const unassigned = (await run({ operation: "unassign", number: parked.number })).tasks[0]!;
  expect(unassigned).toMatchObject({ status: "backlog", owner: null });
});

test("a closed task stays closed when its assignee is released", async () => {
  const task = await started("Closed with an owner");
  await run({ operation: "update", number: task.number, status: "closed" });
  const released = (await run({ operation: "unassign", number: task.number })).tasks[0]!;
  expect(released).toMatchObject({ status: "closed", owner: null });
});
