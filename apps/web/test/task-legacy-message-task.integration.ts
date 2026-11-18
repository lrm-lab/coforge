import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { discussionOf } from "#src/server/tasks/task-discussion-store.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { legacyMessageTask } from "./fixtures/legacy-message-task";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let workspaceId = "";
let userId = "";
let channel: { id: string; channelName: string | null };
let creatorMemberId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: { displayName: `legacy-${handle}`, username: `legacy-${handle}` },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-legacy-${handle}`,
      name: "Legacy tasks",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `legacy-${handle}`,
      members: { create: [{ userId: user.id }] },
    },
  });
  creatorMemberId = (
    await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: user.id },
    })
  ).id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

const legacyTask = async (title: string) =>
  (
    await legacyMessageTask(db, {
      conversationId: channel.id,
      workspaceId,
      creatorMemberId,
      title,
    })
  ).task;

test("two concurrent first uses of an old task's conversation make exactly one, and both get its id", async () => {
  const task = await legacyTask("Opened twice at once");
  expect(task.discussionConversationId).toBeNull();

  const ids = await Promise.all(
    Array.from({ length: 6 }, () =>
      db.$transaction((tx) =>
        discussionOf(tx, { id: task.id, discussionConversationId: null }, workspaceId),
      ),
    ),
  );

  expect(new Set(ids).size).toBe(1);
  const stored = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { discussionConversationId: true },
  });
  expect(stored.discussionConversationId).toBe(ids[0]!);
  expect(
    await db.conversation.count({
      where: { workspaceId, kind: "task_thread", taskDiscussionOf: { id: task.id } },
    }),
  ).toBe(1);
});

test("two concurrent first opens of the same old task through the service make one conversation", async () => {
  const task = await legacyTask("Opened by two people");
  const second = await db.user.create({
    data: { displayName: `legacy-two-${handle}`, username: `legacy-two-${handle}` },
  });
  try {
    await db.workspaceMembership.create({ data: { workspaceId, userId: second.id } });
    await db.conversationMember.create({
      data: { workspaceId, conversationId: channel.id, userId: second.id },
    });
    const conversations = new TaskConversations({ db, reader: "people", dependencies: {} });
    const ref = { conversationId: channel.id, number: task.number };
    const [first, other] = await Promise.all(
      [userId, second.id].map((id) => conversations.open({ workspaceId, userId: id }, ref)),
    );
    expect(first.conversationId).toBe(other.conversationId);
    expect(
      await db.conversation.count({
        where: { workspaceId, kind: "task_thread", taskDiscussionOf: { id: task.id } },
      }),
    ).toBe(1);
  } finally {
    await db.user.delete({ where: { id: second.id } });
  }
});

test("an old task made from a channel message still names that message and its thread in the task view", async () => {
  const task = await legacyTask("Fix the quota page");
  const reply = await db.message.create({
    data: {
      conversationId: channel.id,
      workspaceId,
      senderMemberId: creatorMemberId,
      body: "a reply in the old thread",
      sequence: 1_000,
      threadRootId: task.messageId,
    },
  });
  const [view] = (
    await new TaskBoard(db).execute(
      { workspaceId, userId },
      {
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
      },
    )
  ).tasks.filter(({ id }) => id === task.id);

  expect(reply.threadRootId).toBe(task.messageId);
  expect(view).toMatchObject({
    messageId: task.messageId,
    earlierDiscussion: { threadRootId: task.messageId, replyCount: 1 },
  });
  expect(view!.discussionConversationId).toBeUndefined();
  // The old task is its source message, so it carries no `sourceMessage` of its own.
  expect(view!.sourceMessageId).toBeUndefined();
  expect(view!.sourceMessage).toBeNull();
});

test("an old task's notices and receipts go to its own conversation and never to its message thread", async () => {
  const task = await legacyTask("Quiet old thread");
  const board = new TaskBoard(db);
  const principal = { workspaceId, userId };
  await board.execute(principal, {
    operation: "assign",
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    number: task.number,
    assignee: `user:${userId}`,
  });
  await board.execute(principal, {
    operation: "update",
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    number: task.number,
    status: "in_progress",
  });

  expect(await db.message.count({ where: { threadRootId: task.messageId } })).toBe(0);
  expect(await db.threadFollow.count({ where: { rootMessageId: task.messageId! } })).toBe(0);
  const stored = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { discussionConversationId: true },
  });
  const notices = await db.systemMessage.findMany({
    where: { conversationId: stored.discussionConversationId! },
    select: { kind: true },
  });
  expect(notices).toEqual([{ kind: "task.assigned" }]);
});

test("an old task's unfollow notice goes to its own conversation, and with no word in it it posts nothing", async () => {
  const task = await legacyTask("Followed once");
  const conversations = new TaskConversations({ db, reader: "people", dependencies: {} });
  const ref = { conversationId: channel.id, number: task.number };
  const principal = { workspaceId, userId };

  await conversations.follow(principal, ref);
  await conversations.unfollow(principal, ref);
  expect(await db.message.count({ where: { threadRootId: task.messageId } })).toBe(0);
  expect(
    (await db.task.findUniqueOrThrow({ where: { id: task.id } })).discussionConversationId,
  ).toBeNull();

  const { conversationId } = await conversations.open(principal, ref);
  await conversations.follow(principal, ref);
  await conversations.unfollow(principal, ref);
  expect(await db.systemMessage.count({ where: { conversationId } })).toBe(0);

  await conversations.follow(principal, ref);
  await conversations.reply(principal, ref, { body: "a first word" });
  await conversations.unfollow(principal, ref, "not mine");
  expect(await db.message.count({ where: { threadRootId: task.messageId } })).toBe(0);
  expect(
    await db.systemMessage.findMany({ where: { conversationId }, select: { kind: true } }),
  ).toEqual([{ kind: "task.unfollowed" }]);
});
