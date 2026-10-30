import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
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
  const board = async (visibility: "public" | "private") => {
    const channel = await db.conversation.create({
      data: {
        workspaceId,
        channelName: `tcpage-${visibility}-${suffix}`,
        visibility,
        members: { create: [{ userId: users.reader.id }] },
      },
      include: { members: true },
    });
    const task = await db.task.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        number: 7,
        title: "a task",
        creatorMemberId: channel.members[0]!.id,
      },
    });
    const notice = await db.$transaction((tx) =>
      postTaskNotice(tx, { conversationId: channel.id, workspaceId }, task.id, { body: "m1" }),
    );
    return notice.conversationId;
  };
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
  expect(page.senderMemberId).toBeNull();
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
