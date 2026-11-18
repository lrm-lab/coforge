import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskConversationPages } from "#src/server/conversations/task-conversation-page.server";
import { postTaskNotice, TaskConversations } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);
let workspaceId = "";
let boardId = "";
let userId = "";
let agentId = "";
let agentMemberId = "";
const conversations = new TaskConversations({ db, reader: "agent", dependencies: {} });
const pages = new TaskConversationPages(db);
const asAgent = () => ({ workspaceId, agentId });
const refOf = (number: number) => ({ conversationId: boardId, number });
const agentRef = (number: number) => ({ target: `#tl-${suffix}`, number });

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `tl-user-${suffix}`, displayName: "Reader" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-timeline-${suffix}`,
      name: "Task timeline",
      members: { create: { userId, role: "member" } },
      agents: {
        create: {
          name: `tl-agent-${suffix}`,
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
      channelName: `tl-${suffix}`,
      members: { create: [{ userId }, { agentId }] },
    },
    include: { members: true },
  });
  boardId = board.id;
  agentMemberId = board.members.find((member) => member.agentId === agentId)!.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

const makeTask = (number: number) =>
  db.task.create({
    data: {
      conversationId: boardId,
      workspaceId,
      number,
      title: `task ${number}`,
      creatorMemberId: agentMemberId,
    },
  });

const noticeOf = (taskId: string, kind: string, seconds: number) =>
  db
    .$transaction((tx) =>
      postTaskNotice(tx, { conversationId: boardId, workspaceId }, taskId, {
        body: kind,
        system: { kind, params: {} } as never,
      }),
    )
    .then((message) => stamp(message.id, seconds));

const replyOf = (number: number, body: string, seconds: number) =>
  conversations
    .reply(asAgent(), agentRef(number), { body })
    .then((sent) => stamp(sent.messageId, seconds));

const stamp = async (messageId: string, seconds: number) => {
  await db.message.update({ where: { id: messageId }, data: { createdAt: at(seconds) } });
  return messageId;
};

const eventOf = (taskId: string, seq: number, seconds: number) =>
  db.taskHistoryEvent.create({
    data: {
      taskId,
      seq,
      eventType: "priority_changed",
      actorType: "user",
      actorName: "someone",
      payload: { from: "none", to: "high" },
      createdAt: at(seconds),
    },
  });

const discussionOf = async (taskId: string) =>
  (await db.task.findUniqueOrThrow({ where: { id: taskId } })).discussionConversationId!;

test("a task's conversation pages and counts its receipt and replies", async () => {
  const task = await makeTask(1);
  await replyOf(1, "hello", 10);
  await noticeOf(task.id, "task.assigned_you", 14);
  await replyOf(1, "bye", 15);
  const bodies = ["hello", "task.assigned_you", "bye"];
  const conversationId = await discussionOf(task.id);

  const view = await conversations.view(asAgent(), agentRef(1), { limit: 20 });
  expect(view.recentMessages.map((message) => message.body)).toEqual(bodies);
  expect(view.conversation.replyCount).toBe(3);
  expect(view.hasOlder).toBe(false);

  const [followed] = await conversations.following(asAgent());
  expect(followed?.unread).toBe(1);

  const read = await conversations.read(asAgent(), agentRef(1), {});
  expect(read.messages.map((message) => String(message.body))).toEqual(bodies);

  const newest = await pages.page(workspaceId, userId, conversationId, { limit: 2 });
  expect(newest.messages.map((message) => message.body)).toEqual(["task.assigned_you", "bye"]);
  expect(newest.hasOlder).toBe(true);
  const oldest = await pages.page(workspaceId, userId, conversationId, {
    limit: 2,
    beforeSequence: newest.messages[0]!.sequence,
  });
  expect(oldest.messages.map((message) => message.body)).toEqual(["hello"]);
  expect(oldest.hasOlder).toBe(false);

  const arrived = await pages.updates(workspaceId, userId, conversationId, 0);
  expect(arrived.map((message) => message.body)).toEqual(bodies);

  expect(await db.message.count({ where: { conversationId } })).toBe(3);
});

test("a size-limited view and read page hold exactly the limit and page back to the older entries", async () => {
  await makeTask(2);
  await replyOf(2, "one", 10);
  await replyOf(2, "two", 13);
  await replyOf(2, "three", 15);
  const view = await conversations.view(asAgent(), agentRef(2), { limit: 2 });
  expect(view.recentMessages.map((message) => message.body)).toEqual(["two", "three"]);
  expect(view.hasOlder).toBe(true);
  const read = await conversations.read(asAgent(), agentRef(2), { limit: 2 });
  expect(read.messages.map((message) => String(message.body))).toEqual(["two", "three"]);
  expect(read.hasOlder).toBe(true);
  const older = await conversations.read(asAgent(), agentRef(2), {
    limit: 2,
    before: read.messages[0]!.id,
  });
  expect(older.messages.map((message) => String(message.body))).toEqual(["one"]);
  expect(older.hasOlder).toBe(false);
});

const humanReply = (number: number, body: string, seconds: number) =>
  conversations
    .reply({ workspaceId, userId }, refOf(number), { body })
    .then((sent) => stamp(sent.messageId, seconds));

const secondsOf = (events: { createdAt: string }[]) =>
  events.map((event) => (Date.parse(event.createdAt) - T0) / 1000);

const windowOf = (page: { messages: { sequence: number }[] }, last: boolean) => ({
  oldestSequence: page.messages[0]!.sequence,
  ...(last ? {} : { newestSequence: page.messages.at(-1)!.sequence }),
});

test("each history event belongs to the page holding the first message at or after it", async () => {
  const task = await makeTask(3);
  for (const [index, seconds] of [10, 20, 30, 40].entries())
    await replyOf(3, `m${index + 1}`, seconds);
  for (const [index, seconds] of [5, 10, 25, 30, 45].entries())
    await eventOf(task.id, index + 1, seconds);
  const conversationId = await discussionOf(task.id);
  const newest = await pages.page(workspaceId, userId, conversationId, { limit: 2 });
  const older = await pages.page(workspaceId, userId, conversationId, {
    limit: 2,
    beforeSequence: newest.messages[0]!.sequence,
  });
  const newestEvents = await pages.events(
    workspaceId,
    userId,
    conversationId,
    windowOf(newest, true),
  );
  const olderEvents = await pages.events(
    workspaceId,
    userId,
    conversationId,
    windowOf(older, false),
  );
  expect(secondsOf(newestEvents)).toEqual([25, 30, 45]);
  expect(secondsOf(olderEvents)).toEqual([5, 10]);

  const read = await conversations.read(asAgent(), agentRef(3), { limit: 2 });
  expect(secondsOf(read.events)).toEqual([25, 30, 45]);
  const readOlder = await conversations.read(asAgent(), agentRef(3), {
    limit: 2,
    before: read.messages[0]!.id,
  });
  expect(secondsOf(readOlder.events)).toEqual([5, 10]);
});

test("an event at the instant of two messages across a page boundary appears once, before the first", async () => {
  const task = await makeTask(11);
  for (const [index, seconds] of [10, 20, 30, 30, 40].entries())
    await replyOf(11, `m${index + 1}`, seconds);
  await eventOf(task.id, 1, 30);
  const conversationId = await discussionOf(task.id);
  const newest = await pages.page(workspaceId, userId, conversationId, { limit: 2 });
  const middle = await pages.page(workspaceId, userId, conversationId, {
    limit: 2,
    beforeSequence: newest.messages[0]!.sequence,
  });
  const oldest = await pages.page(workspaceId, userId, conversationId, {
    limit: 2,
    beforeSequence: middle.messages[0]!.sequence,
  });
  const owned = async (page: typeof newest, last: boolean) =>
    (await pages.events(workspaceId, userId, conversationId, windowOf(page, last))).length;
  expect([
    await owned(newest, true),
    await owned(middle, false),
    await owned(oldest, false),
  ]).toEqual([0, 1, 0]);
});

test("an unread read shows what changed since the last read, with or without a new message", async () => {
  const task = await makeTask(8);
  await humanReply(8, "m1", 10);
  await humanReply(8, "m2", 20);
  await conversations.read(asAgent(), agentRef(8), {});
  await eventOf(task.id, 1, 25);
  await humanReply(8, "m3", 30);
  const unread = await conversations.read(asAgent(), agentRef(8), { unread: true });
  expect(unread.messages.map((message) => String(message.body))).toEqual(["m3"]);
  expect(secondsOf(unread.events)).toEqual([25]);

  const quiet = await makeTask(9);
  await humanReply(9, "m1", 10);
  await conversations.read(asAgent(), agentRef(9), {});
  await eventOf(quiet.id, 1, 15);
  const none = await conversations.read(asAgent(), agentRef(9), { unread: true });
  expect(none.messages).toEqual([]);
  expect(secondsOf(none.events)).toEqual([15]);
});

test("a read after a message shows the events since it", async () => {
  const task = await makeTask(10);
  const first = await humanReply(10, "m1", 10);
  await humanReply(10, "m2", 20);
  await humanReply(10, "m3", 30);
  await eventOf(task.id, 1, 5);
  await eventOf(task.id, 2, 15);
  await eventOf(task.id, 3, 35);
  const read = await conversations.read(asAgent(), agentRef(10), { after: first });
  expect(read.messages.map((message) => String(message.body))).toEqual(["m2", "m3"]);
  expect(secondsOf(read.events)).toEqual([15, 35]);
});

test("a conversation with no messages gets every event", async () => {
  const task = await makeTask(4);
  await eventOf(task.id, 1, 5);
  await eventOf(task.id, 2, 6);
  const { conversationId } = await conversations.open({ workspaceId, userId }, refOf(4));
  const events = await pages.events(workspaceId, userId, conversationId, {});
  expect(events.map((event) => event.seq)).toEqual([1, 2]);
  expect((await conversations.read(asAgent(), agentRef(4), {})).events).toHaveLength(2);
});

test("a task with no conversation still reads its events", async () => {
  const task = await makeTask(5);
  await eventOf(task.id, 1, 5);
  const view = await conversations.view(asAgent(), agentRef(5), { limit: 5 });
  expect(view.conversation.exists).toBe(false);
  expect(view.recentEvents.map((event) => event.seq)).toEqual([1]);
  expect((await conversations.read(asAgent(), agentRef(5), {})).events).toHaveLength(1);
});

test("the view's merged stream honours the limit and says whether older entries exist", async () => {
  const quiet = await makeTask(6);
  for (let seq = 1; seq <= 8; seq++) await eventOf(quiet.id, seq, seq);
  const onlyEvents = await conversations.view(asAgent(), agentRef(6), { limit: 3 });
  expect(onlyEvents.recentMessages).toEqual([]);
  expect(onlyEvents.recentEvents.map((event) => event.seq)).toEqual([6, 7, 8]);
  expect(onlyEvents.hasOlder).toBe(true);

  const mixed = await makeTask(7);
  await replyOf(7, "a", 10);
  await replyOf(7, "b", 30);
  for (const [index, seconds] of [5, 20, 25, 40].entries())
    await eventOf(mixed.id, index + 1, seconds);
  const view = await conversations.view(asAgent(), agentRef(7), { limit: 3 });
  expect(view.recentMessages.map((message) => message.body)).toEqual(["b"]);
  expect(view.recentEvents.map((event) => event.seq)).toEqual([3, 4]);
  expect(view.hasOlder).toBe(true);
  const whole = await conversations.view(asAgent(), agentRef(7), { limit: 20 });
  expect(whole.recentMessages).toHaveLength(2);
  expect(whole.recentEvents).toHaveLength(4);
  expect(whole.hasOlder).toBe(false);
});
