import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { TaskConversationPages } from "#src/server/conversations/task-conversation-page.server";
import { postTaskNotice } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let discussionId = "";
let privateDiscussionId = "";
let dmId = "";
const users = {} as Record<"reader" | "outsider", { id: string }>;
const pages = new TaskConversationPages(db);

const board = async (visibility: "public" | "private", number = 7) => {
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tcpage-${visibility}-${number}-${suffix}`,
      visibility,
      members: { create: [{ userId: users.reader.id }] },
    },
    include: { members: true },
  });
  const task = await db.task.create({
    data: {
      conversationId: channel.id,
      workspaceId,
      number,
      title: "a task",
      creatorMemberId: channel.members[0]!.id,
    },
  });
  const notice = await db.$transaction((tx) =>
    postTaskNotice(tx, { conversationId: channel.id, workspaceId }, task.id, { body: "m1" }),
  );
  return notice.conversationId;
};

beforeAll(async () => {
  const made = await Promise.all(
    (["reader", "outsider"] as const).map((key) =>
      db.user.create({ data: { username: `tcp-${key}-${suffix}`, displayName: key } }),
    ),
  );
  users.reader = { id: made[0]!.id };
  users.outsider = { id: made[1]!.id };
  const workspace = await db.workspace.create({
    data: {
      slug: `task-conv-page-${suffix}`,
      name: "Task conversation pages",
      members: { create: made.map((user) => ({ userId: user.id, role: "member" })) },
    },
  });
  workspaceId = workspace.id;
  discussionId = await board("public");
  privateDiscussionId = await board("private");
  for (let sequence = 2; sequence <= 7; sequence++)
    await db.message.create({
      data: { workspaceId, conversationId: discussionId, body: `m${sequence}`, sequence },
    });
  await db.conversation.update({ where: { id: discussionId }, data: { lastSequence: 7 } });
  const dm = await db.conversation.create({
    data: { workspaceId, directKey: `${users.reader.id}|${users.outsider.id}` },
  });
  dmId = dm.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: [users.reader.id, users.outsider.id] } } });
  await db.$disconnect();
});

test("the newest page comes first and older ones follow by sequence", async () => {
  const newest = await pages.page(workspaceId, users.reader.id, discussionId, { limit: 3 });
  expect(newest.messages.map((message) => message.body)).toEqual(["m5", "m6", "m7"]);
  expect(newest).toMatchObject({ kind: "task", taskNumber: 7, hasOlder: true, hasNewer: false });
  const older = await pages.page(workspaceId, users.reader.id, discussionId, {
    limit: 3,
    beforeSequence: newest.messages[0]!.sequence,
  });
  expect(older.messages.map((message) => message.body)).toEqual(["m2", "m3", "m4"]);
  expect(older.hasOlder).toBe(true);
  const oldest = await pages.page(workspaceId, users.reader.id, discussionId, {
    limit: 3,
    beforeSequence: older.messages[0]!.sequence,
  });
  expect(oldest).toMatchObject({ hasOlder: false });
  expect(oldest.messages.map((message) => message.body)).toEqual(["m1"]);
});

test("a person with no seat has nothing unread, and the board's people can be mentioned", async () => {
  const page = await pages.page(workspaceId, users.reader.id, discussionId);
  expect(page.senderMemberId).toBeUndefined();
  expect(page.readThroughSequence).toBe(7);
  expect(page.mentionables.map((mentionable) => mentionable.handle)).toEqual([
    `tcp-reader-${suffix}`,
  ]);
});

test("updates are what arrived after a sequence", async () => {
  const updates = await pages.updates(workspaceId, users.reader.id, discussionId, 5);
  expect(updates.map((message) => message.body)).toEqual(["m6", "m7"]);
});

test("a private board's conversation is not found by someone off the board", async () => {
  await expect(
    pages.page(workspaceId, users.outsider.id, privateDiscussionId),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    pages.updates(workspaceId, users.outsider.id, privateDiscussionId, 0),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a conversation that is not a task's is refused", async () => {
  await expect(pages.page(workspaceId, users.reader.id, dmId)).rejects.toThrow();
});

test("the first page can be read forward from the start and then has nothing older", async () => {
  const first = await pages.page(workspaceId, users.reader.id, discussionId, {
    afterSequence: 0,
    limit: 3,
  });
  expect(first.messages.map((message) => message.body)).toEqual(["m1", "m2", "m3"]);
  expect(first).toMatchObject({ hasOlder: false, hasNewer: true });
  const next = await pages.page(workspaceId, users.reader.id, discussionId, {
    afterSequence: 3,
    limit: 3,
  });
  expect(next.messages.map((message) => message.body)).toEqual(["m4", "m5", "m6"]);
  expect(next).toMatchObject({ hasOlder: true, hasNewer: true });
  const tail = await pages.page(workspaceId, users.reader.id, discussionId, {
    afterSequence: 6,
    limit: 3,
  });
  expect(tail).toMatchObject({ hasOlder: true, hasNewer: false });
});

test("a reader with no seat reads the window around a message of a task's conversation", async () => {
  const target = await db.message.findFirstOrThrow({
    where: { conversationId: discussionId, body: "m4" },
    select: { id: true },
  });
  const history = new ConversationHistory(db);
  const around = await history.loadAround(workspaceId, users.reader.id, discussionId, target.id);
  expect(around.anchorMessageId).toBe(target.id);
  expect(around.messages.map((message) => message.body)).toContain("m4");
  await expect(
    history.loadAround(workspaceId, users.outsider.id, privateDiscussionId, target.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("the unread count is others' messages past the read position, never notices or one's own", async () => {
  const conversationId = await board("public", 20);
  const [reader, other] = await Promise.all(
    [users.reader.id, users.outsider.id].map((userId) =>
      db.conversationMember.create({ data: { conversationId, workspaceId, userId } }),
    ),
  );
  const say = (sequence: number, senderMemberId: string | null) =>
    db.message.create({
      data: { workspaceId, conversationId, body: `u${sequence}`, sequence, senderMemberId },
    });
  const first = await say(2, other!.id);
  await say(3, null);
  await say(4, reader!.id);
  const fifth = await say(5, other!.id);
  const sixth = await say(6, other!.id);
  await db.conversation.update({ where: { id: conversationId }, data: { lastSequence: 6 } });
  const readThrough = (sequence: number, unreadFromSequence: number | null = null) =>
    db.conversationMember.update({
      where: { id: reader!.id },
      data: { readThroughSequence: sequence, unreadFromSequence },
    });
  await readThrough(1);
  expect(await pages.page(workspaceId, users.reader.id, conversationId)).toMatchObject({
    firstUnreadMessageId: first.id,
  });
  expect(await pages.unread(workspaceId, users.reader.id, conversationId)).toEqual({
    unreadCount: 3,
    firstUnreadMessageId: first.id,
  });
  await readThrough(5);
  expect(await pages.unread(workspaceId, users.reader.id, conversationId)).toEqual({
    unreadCount: 1,
    firstUnreadMessageId: sixth.id,
  });
  await readThrough(6, 5);
  expect(await pages.unread(workspaceId, users.reader.id, conversationId)).toEqual({
    unreadCount: 2,
    firstUnreadMessageId: fifth.id,
  });
});

test("a reader with no seat has nothing unread", async () => {
  expect(await pages.unread(workspaceId, users.outsider.id, discussionId)).toEqual({
    unreadCount: 0,
    firstUnreadMessageId: null,
  });
});
