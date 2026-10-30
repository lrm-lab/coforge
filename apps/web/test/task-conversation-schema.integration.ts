import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId: string;
let channelId: string;
let memberId: string;

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `tc-schema-${suffix}`, displayName: "Owner" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-conv-schema-${suffix}`,
      name: "Task conversation schema",
      members: { create: { userId: owner.id, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tc-${suffix}`,
      members: { create: [{ userId: owner.id }] },
    },
    include: { members: true },
  });
  channelId = channel.id;
  memberId = channel.members[0]!.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

test("a task may have no message, its own conversation, a source message and followers", async () => {
  const source = await db.message.create({
    data: { conversationId: channelId, workspaceId, body: "please do this", sequence: 1 },
  });
  const discussion = await db.conversation.create({
    data: { workspaceId, kind: "task_thread" },
  });
  const task = await db.task.create({
    data: {
      conversationId: channelId,
      workspaceId,
      number: 1,
      title: "No message in the channel",
      creatorMemberId: memberId,
      sourceMessageId: source.id,
      discussionConversationId: discussion.id,
    },
  });
  await db.taskFollow.create({
    data: { taskId: task.id, memberId, conversationId: channelId, workspaceId, reason: "created" },
  });
  expect(task.messageId).toBeNull();
  expect(await db.taskFollow.count({ where: { taskId: task.id } })).toBe(1);

  // Two tasks may come from one message, but a conversation belongs to one task.
  await db.task.create({
    data: {
      conversationId: channelId,
      workspaceId,
      number: 2,
      title: "Second from the same message",
      creatorMemberId: memberId,
      sourceMessageId: source.id,
    },
  });
  await expect(
    (async () =>
      db.task.create({
        data: {
          conversationId: channelId,
          workspaceId,
          number: 3,
          title: "Same conversation",
          creatorMemberId: memberId,
          discussionConversationId: discussion.id,
        },
      }))(),
  ).rejects.toThrow();

  // The source message going away leaves the task; the task going away takes its follows.
  await db.message.delete({ where: { id: source.id } });
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).sourceMessageId).toBeNull();
  await db.task.delete({ where: { id: task.id } });
  expect(await db.taskFollow.count({ where: { taskId: task.id } })).toBe(0);
});

test("only the known kinds of conversation exist", async () => {
  await expect(
    (async () => db.conversation.create({ data: { workspaceId, kind: "task_threadz" } }))(),
  ).rejects.toThrow();
});
