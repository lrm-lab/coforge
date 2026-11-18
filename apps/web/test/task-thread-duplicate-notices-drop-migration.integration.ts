import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { postTaskNotice } from "#src/server/tasks/task-conversations.server";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("MIGRATION_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_task_thread_duplicate_notices_drop"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";

let workspaceId = "";
let userId = "";
let agentId = "";
let boardId = "";
let taskNumber = 0;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `dn-user-${suffix}`, displayName: "Reader" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `dup-notices-${suffix}`,
      name: "Duplicate notices",
      members: { create: { userId, role: "member" } },
      agents: {
        create: {
          name: `dn-agent-${suffix}`,
          displayName: "worker",
          ownerId: userId,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  agentId = workspace.agents[0]!.id;
  const board = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `dn-${suffix}`,
      members: { create: [{ userId }, { agentId }] },
    },
  });
  boardId = board.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

const makeTask = async () => {
  const creator = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: boardId, agentId },
  });
  return db.task.create({
    data: {
      conversationId: boardId,
      workspaceId,
      number: ++taskNumber,
      title: `task ${taskNumber}`,
      creatorMemberId: creator.id,
    },
  });
};

const notice = (taskId: string, kind: string, deliverToAgentId?: string) =>
  db.$transaction((tx) =>
    postTaskNotice(tx, { conversationId: boardId, workspaceId }, taskId, {
      body: kind,
      system: { kind, params: {} } as never,
      deliverToAgentId,
    }),
  );

const taskConversationOf = async (taskId: string) =>
  (await db.task.findUniqueOrThrow({ where: { id: taskId } })).discussionConversationId!;

const exists = async (messageId: string) =>
  (await db.message.count({ where: { id: messageId } })) === 1;

const run = () => db.$executeRawUnsafe(migration);

test("the migration exists", () => {
  expect(migrationName).toBeDefined();
});

test("the three duplicate notices of a Task's conversation go with their dependents, nothing else does", async () => {
  const task = await makeTask();
  const moved = await notice(task.id, "task.moved", agentId);
  const claimed = await notice(task.id, "task.claimed");
  const unassigned = await notice(task.id, "task.unassigned");
  const receipt = await notice(task.id, "task.assigned_you");
  const conversationId = await taskConversationOf(task.id);
  const seat = await db.conversationMember.create({
    data: { conversationId, workspaceId, userId },
  });
  const reply = await db.message.create({
    data: {
      conversationId,
      workspaceId,
      senderMemberId: seat.id,
      body: "a reply",
      sequence: receipt.sequence + 1,
    },
  });
  await db.conversation.update({
    where: { id: conversationId },
    data: { lastSequence: reply.sequence },
  });
  for (const message of [moved, claimed, receipt]) {
    await db.messageReaction.create({
      data: { messageId: message.id, conversationId, workspaceId, memberId: seat.id, emoji: "👍" },
    });
    await db.savedMessage.create({
      data: { messageId: message.id, conversationId, workspaceId, memberId: seat.id },
    });
  }
  expect(await db.agentMessageDelivery.count({ where: { messageId: moved.id } })).toBe(1);

  await run();

  expect(await exists(moved.id)).toBe(false);
  expect(await exists(claimed.id)).toBe(false);
  expect(await exists(unassigned.id)).toBe(false);
  expect(await exists(receipt.id)).toBe(true);
  expect(await exists(reply.id)).toBe(true);
  expect(
    await db.systemMessage.count({
      where: { messageId: { in: [moved.id, claimed.id, unassigned.id] } },
    }),
  ).toBe(0);
  expect(
    await db.messageReaction.count({ where: { messageId: { in: [moved.id, claimed.id] } } }),
  ).toBe(0);
  expect(
    await db.savedMessage.count({ where: { messageId: { in: [moved.id, claimed.id] } } }),
  ).toBe(0);
  expect(await db.agentMessageDelivery.count({ where: { messageId: moved.id } })).toBe(0);
  expect(await db.messageReaction.count({ where: { messageId: receipt.id } })).toBe(1);
  expect(await db.savedMessage.count({ where: { messageId: receipt.id } })).toBe(1);

  const after = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  expect(after.lastSequence).toBe(reply.sequence);
  const remaining = await db.message.findMany({
    where: { conversationId },
    orderBy: { sequence: "asc" },
    select: { id: true },
  });
  expect(remaining.map((message) => message.id)).toEqual([receipt.id, reply.id]);
});

test("the same kinds outside a task_thread stay", async () => {
  const sequence =
    (await db.conversation.findUniqueOrThrow({ where: { id: boardId } })).lastSequence + 1;
  const legacy = await db.message.create({
    data: { conversationId: boardId, workspaceId, body: "claimed", sequence },
  });
  await db.conversation.update({ where: { id: boardId }, data: { lastSequence: sequence } });
  await db.systemMessage.create({
    data: {
      messageId: legacy.id,
      conversationId: boardId,
      workspaceId,
      kind: "task.claimed",
      params: {},
    },
  });
  await run();
  expect(await exists(legacy.id)).toBe(true);
  expect(await db.systemMessage.count({ where: { messageId: legacy.id } })).toBe(1);
});

test("a notice another message replies to, or another Task is made from, stays", async () => {
  const task = await makeTask();
  const threaded = await notice(task.id, "task.moved");
  const source = await notice(task.id, "task.claimed");
  const conversationId = await taskConversationOf(task.id);
  const reply = await db.message.create({
    data: {
      conversationId,
      workspaceId,
      body: "in the thread",
      sequence: source.sequence + 1,
      threadRootId: threaded.id,
    },
  });
  await db.conversation.update({
    where: { id: conversationId },
    data: { lastSequence: reply.sequence },
  });
  const made = await makeTask();
  await db.$executeRaw`UPDATE "tasks" SET "sourceMessageId" = ${source.id}::uuid WHERE "id" = ${made.id}::uuid`;

  await run();

  expect(await exists(threaded.id)).toBe(true);
  expect(await exists(reply.id)).toBe(true);
  expect(await exists(source.id)).toBe(true);
  expect((await db.task.findUniqueOrThrow({ where: { id: made.id } })).sourceMessageId).toBe(
    source.id,
  );
});

test("running it again changes nothing", async () => {
  const task = await makeTask();
  const kept = await notice(task.id, "task.assigned_you");
  await notice(task.id, "task.unassigned");
  await run();
  await run();
  expect(await exists(kept.id)).toBe(true);
  expect(
    await db.message.count({ where: { conversationId: await taskConversationOf(task.id) } }),
  ).toBe(1);
});
