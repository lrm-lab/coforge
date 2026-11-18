import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { sentMessageSpawnsTask } from "#src/server/tasks/sent-as-conversation-task.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { TaskConversations, postTaskNotice } from "#src/server/tasks/task-conversations.server";
import { legacyMessageTask } from "./fixtures/legacy-message-task";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let channelId = "";
let sourceId = "";
const people = {} as Record<"actor" | "author", { id: string; memberId: string }>;
const board = new TaskBoard(db, {});
const run = (command: Record<string, unknown>) =>
  board.execute({ workspaceId, userId: people.actor.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: channelId,
    ...command,
  } as Parameters<TaskBoard["execute"]>[1]);

beforeAll(async () => {
  const users = await Promise.all(
    (["actor", "author"] as const).map((key) =>
      db.user.create({ data: { username: `tca-${key}-${suffix}`, displayName: key } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-always-${suffix}`,
      name: "Task conversations always",
      members: { create: users.map((user) => ({ userId: user.id, role: "owner" })) },
    },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tca-${suffix}`,
      members: { create: users.map((user) => ({ userId: user.id })) },
    },
    include: { members: true },
  });
  channelId = channel.id;
  for (const [index, key] of (["actor", "author"] as const).entries())
    people[key] = {
      id: users[index]!.id,
      memberId: channel.members.find((member) => member.userId === users[index]!.id)!.id,
    };
  sourceId = (
    await db.message.create({
      data: {
        conversationId: channelId,
        workspaceId,
        senderMemberId: people.author.memberId,
        body: "please fix the login page",
        sequence: 1,
      },
    })
  ).id;
  await db.conversation.update({ where: { id: channelId }, data: { lastSequence: 100 } });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: Object.values(people).map((p) => p.id) } } });
  await db.$disconnect();
});

async function expectOwnConversation(taskId: string) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { discussionConversationId: true, discussion: true },
  });
  expect(task.discussionConversationId).toBeString();
  expect(task.discussion).toMatchObject({
    id: task.discussionConversationId!,
    kind: "task_thread",
    workspaceId,
  });
  expect(
    await db.message.count({ where: { conversationId: task.discussionConversationId! } }),
  ).toBe(0);
}

test("a created task has its own task_thread conversation, empty", async () => {
  const { tasks } = await run({ operation: "create", title: "Write the docs" });
  await expectOwnConversation(tasks[0]!.id);
});

test("every task of a create with several titles has its own conversation", async () => {
  const { tasks } = await run({ operation: "create", titles: ["One", "Two", "Three"] });
  expect(tasks).toHaveLength(3);
  for (const task of tasks) await expectOwnConversation(task.id);
  const ids = await db.task.findMany({
    where: { id: { in: tasks.map((task) => task.id) } },
    select: { discussionConversationId: true },
  });
  expect(new Set(ids.map((row) => row.discussionConversationId)).size).toBe(3);
});

test("a subtask has its own conversation beside its parent's", async () => {
  const { tasks: parents } = await run({ operation: "create", title: "Parent" });
  const { tasks } = await run({
    operation: "create",
    title: "Child",
    parent: { number: parents[0]!.number },
  });
  await expectOwnConversation(tasks[0]!.id);
  const [parent, child] = await Promise.all(
    [parents[0]!.id, tasks[0]!.id].map((id) => db.task.findUniqueOrThrow({ where: { id } })),
  );
  expect(parent!.discussionConversationId).not.toBe(child!.discussionConversationId);
});

test("a task converted from a message has its own conversation", async () => {
  const { tasks } = await run({ operation: "convert", messageId: sourceId });
  await expectOwnConversation(tasks[0]!.id);
});

test("a task sent as a task from the composer has its own conversation", async () => {
  const sent = await db.message.create({
    data: {
      conversationId: channelId,
      workspaceId,
      senderMemberId: people.actor.memberId,
      body: "ship it",
      sequence: 20,
    },
  });
  await db.$transaction((tx) =>
    sentMessageSpawnsTask(tx, {
      id: sent.id,
      conversationId: channelId,
      workspaceId,
      body: sent.body,
      senderMemberId: people.actor.memberId,
      threadRootId: null,
    }),
  );
  const task = await db.task.findFirstOrThrow({ where: { sourceMessageId: sent.id } });
  await expectOwnConversation(task.id);
});

test("an assigned task keeps one conversation, holding only the assignment notice", async () => {
  const { tasks } = await run({
    operation: "create",
    title: "For the author",
    assignee: `@tca-author-${suffix}`,
  });
  const task = await db.task.findUniqueOrThrow({ where: { id: tasks[0]!.id } });
  expect(
    await db.conversation.count({
      where: { workspaceId, kind: "task_thread", taskDiscussionOf: { id: task.id } },
    }),
  ).toBe(1);
  expect(
    await db.message.count({ where: { conversationId: task.discussionConversationId! } }),
  ).toBe(1);
});

test("concurrent notices on an old task without a conversation make exactly one", async () => {
  const { task } = await legacyMessageTask(db, {
    conversationId: channelId,
    workspaceId,
    creatorMemberId: people.actor.memberId,
    title: "Old, noticed twice at once",
  });
  expect(task.discussionConversationId).toBeNull();
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      db.$transaction((tx) =>
        postTaskNotice(tx, { conversationId: channelId, workspaceId }, task.id, {
          body: `notice ${index}`,
        }),
      ),
    ),
  );
  const stored = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { discussionConversationId: true },
  });
  expect(
    await db.conversation.count({
      where: { workspaceId, kind: "task_thread", taskDiscussionOf: { id: task.id } },
    }),
  ).toBe(1);
  expect(
    await db.message.count({ where: { conversationId: stored.discussionConversationId! } }),
  ).toBe(6);
});

test("a fresh task's empty conversation is not a discussion: no replies, no unfollow line", async () => {
  const { tasks } = await run({ operation: "create", title: "Quiet" });
  const task = tasks[0]!;
  const conversations = new TaskConversations({ db, reader: "people", dependencies: {} });
  const principal = { workspaceId, userId: people.actor.id };
  const ref = { conversationId: channelId, number: task.number };

  expect(await conversations.view(principal, ref, { limit: 5 })).toMatchObject({
    conversation: { exists: true, replyCount: 0 },
    recentMessages: [],
    hasOlder: false,
  });
  await conversations.unfollow(principal, ref, "not mine");
  await expectOwnConversation(task.id);
});
