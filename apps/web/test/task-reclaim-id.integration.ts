import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { silentRealtime } from "./helpers/workspace-member-leave-fixture";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { username: `reclaim-${suffix}`, displayName: "Reclaim" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `reclaim-${suffix}`,
      name: "Reclaim",
      members: { create: { userId: owner.id, role: "admin" } },
    },
  });
  const agent = await db.agent.create({
    data: {
      name: `claim-${suffix}`,
      displayName: "Claim agent",
      ownerId: owner.id,
      workspaceId: workspace.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channels = new PublicChannels(db, undefined, undefined, undefined, silentRealtime);
  const channel = await channels.create(workspace.id, owner.id, `reclaim-${suffix}`);
  await channels.addMembers(workspace.id, { userId: owner.id }, channel.id, {
    userIds: [],
    agentIds: [agent.id],
  });
  const memberRow = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: channel.id, userId: owner.id } },
  });
  const agentRow = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_agentId: { conversationId: channel.id, agentId: agent.id } },
  });
  const message = await db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, channel.id);
    return tx.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: channel.id,
        senderMemberId: memberRow.id,
        sequence,
        body: "the message the claim names",
      },
    });
  });
  return { owner, workspace, agent, channel, memberRow, agentRow, message };
}

test("a reclaim on a cleaned-up task gets a fresh task.id", async () => {
  const f = await fixture();
  const board = new TaskBoard(db);
  const first = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const firstTask = await db.task.findUniqueOrThrow({
    where: { id: first.tasks[0]!.id },
    select: { id: true, messageId: true },
  });
  expect(firstTask.id).not.toBe(f.message.id);
  expect(firstTask.messageId).toBe(f.message.id);

  await db.task.update({
    where: { id: firstTask.id },
    data: { deletedAt: new Date(), deletedByMemberId: f.memberRow.id },
  });
  await db.task.deleteMany({ where: { id: firstTask.id, deletedAt: { not: null } } });

  const reclaim = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const secondTask = await db.task.findUniqueOrThrow({
    where: { id: reclaim.tasks[0]!.id },
    select: { id: true, messageId: true },
  });
  expect(secondTask.id).not.toBe(f.message.id);
  expect(secondTask.id).not.toBe(firstTask.id);
  expect(secondTask.messageId).toBe(f.message.id);
});

test("a second task's delete and restore publish under its fresh id", async () => {
  const f = await fixture();
  const board = new TaskBoard(db);
  const first = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const firstTaskId = first.tasks[0]!.id;
  await db.task.update({
    where: { id: firstTaskId },
    data: { deletedAt: new Date(), deletedByMemberId: f.memberRow.id },
  });
  await db.task.deleteMany({ where: { id: firstTaskId, deletedAt: { not: null } } });

  const publications: string[] = [];
  const board2 = new TaskBoard(db, {
    realtime: {
      ...silentRealtime,
      taskChanged: async (signal) => {
        publications.push(signal.publicationId);
      },
    },
  });
  const reclaim = await board2.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const secondTaskId = reclaim.tasks[0]!.id;
  await board2.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "delete",
      conversationId: f.channel.id,
      number: reclaim.tasks[0]!.number,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  await board2.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "restore",
      conversationId: f.channel.id,
      number: reclaim.tasks[0]!.number,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(publications).toContain(`${secondTaskId}:task-deleted`);
  expect(publications).toContain(`${secondTaskId}:task-restored`);
});

test("an old task's message_references do not point at the reclaimed task", async () => {
  const f = await fixture();
  const board = new TaskBoard(db);
  const first = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const firstTaskId = first.tasks[0]!.id;
  const firstMessage = await db.message.create({
    data: {
      workspaceId: f.workspace.id,
      conversationId: f.channel.id,
      senderMemberId: f.memberRow.id,
      sequence: 10,
      body: `task #${first.tasks[0]!.number} is the first`,
    },
  });
  await db.messageReference.create({
    data: {
      messageId: firstMessage.id,
      conversationId: f.channel.id,
      workspaceId: f.workspace.id,
      kind: "task",
      targetId: firstTaskId,
      raw: `task #${first.tasks[0]!.number}`,
      ordinal: 0,
    },
  });
  await db.task.update({
    where: { id: firstTaskId },
    data: { deletedAt: new Date(), deletedByMemberId: f.memberRow.id },
  });
  await db.task.deleteMany({ where: { id: firstTaskId, deletedAt: { not: null } } });

  const reclaim = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const secondTaskId = reclaim.tasks[0]!.id;
  const references = await db.messageReference.findMany({
    where: { messageId: firstMessage.id },
  });
  expect(references).toHaveLength(1);
  expect(references[0]!.targetId).toBe(firstTaskId);
  expect(references[0]!.targetId).not.toBe(secondTaskId);
});

test("an old task whose id is its message's still reads and writes", async () => {
  const f = await fixture();
  const board = new TaskBoard(db);
  const claimed = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "claim",
      conversationId: f.channel.id,
      messageIds: [f.message.id],
      assignee: "@claim",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const task = await db.task.findUniqueOrThrow({
    where: { id: claimed.tasks[0]!.id },
    select: { id: true, messageId: true, number: true },
  });
  const read = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "list",
      conversationId: f.channel.id,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(read.tasks.some((t) => t.id === task.id)).toBe(true);
  await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "update",
      conversationId: f.channel.id,
      number: task.number,
      status: "done",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(
    (await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).status,
  ).toBe("done");
});

test("createTasks gives the task its own id, not the message's", async () => {
  const f = await fixture();
  const board = new TaskBoard(db);
  const created = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "create",
      conversationId: f.channel.id,
      title: "a task made directly",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const task = await db.task.findUniqueOrThrow({
    where: { id: created.tasks[0]!.id },
    select: { id: true, messageId: true },
  });
  expect(task.id).not.toBe(task.messageId);
});
