import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const KEYS = ["writer", "follower", "bystander"] as const;
type Key = (typeof KEYS)[number];
let workspaceId = "";
let boardId = "";
const people = {} as Record<Key, { id: string; username: string; memberId: string }>;
const changed: string[] = [];
const conversations = new TaskConversations({
  db,
  reader: "people",
  dependencies: {
    realtime: {
      messageAvailable: async () => {},
      activityChanged: async ({ userId }: { userId: string }) => {
        changed.push(userId);
      },
    } as never,
  },
});
const inbox = new ActivityInbox(db, {});
const as = (key: Key) => ({ workspaceId, userId: people[key].id });
const ref = { number: 1, conversationId: "" };
const listed = async (key: Key) =>
  (await inbox.list(workspaceId, people[key].id, { filter: "all" })).items.filter(
    (item) => item.task,
  );

beforeAll(async () => {
  const users = await Promise.all(
    KEYS.map((key) =>
      db.user.create({ data: { username: `tact-${key}-${suffix}`, displayName: key } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-activity-${suffix}`,
      name: "Task activity",
      members: { create: users.map((user) => ({ userId: user.id, role: "member" })) },
    },
  });
  workspaceId = workspace.id;
  const board = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tact-${suffix}`,
      visibility: "private",
      members: { create: users.map((user) => ({ userId: user.id })) },
    },
    include: { members: true },
  });
  boardId = board.id;
  ref.conversationId = boardId;
  for (const [index, key] of KEYS.entries())
    people[key] = {
      id: users[index]!.id,
      username: users[index]!.username,
      memberId: board.members.find((member) => member.userId === users[index]!.id)!.id,
    };
  await db.task.create({
    data: {
      conversationId: boardId,
      workspaceId,
      number: 1,
      title: "Talk about it",
      creatorMemberId: people.writer.memberId,
    },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: KEYS.map((key) => people[key].id) } } });
  await db.$disconnect();
});

test("a follower's Activity lists the task conversation, unread; the author's own message does not", async () => {
  await conversations.follow(as("follower"), ref);
  await conversations.reply(as("writer"), ref, { body: "First thought" });

  const [item] = await listed("follower");
  expect(item).toMatchObject({
    task: { number: 1, title: "Talk about it", boardId },
    place: { kind: "channel", conversationId: boardId },
    unreadCount: 1,
  });
  expect(changed).toContain(people.follower.id);
  expect(changed).not.toContain(people.writer.id);
  const own = (await listed("writer"))[0];
  expect(own?.unreadCount ?? 0).toBe(0);
  expect(await inbox.navAttention(workspaceId, people.follower.id)).toEqual({ hasUnread: true });
});

test("someone who does not follow it hears of it only when mentioned", async () => {
  expect(await listed("bystander")).toEqual([]);
  await conversations.reply(as("writer"), ref, { body: `@${people.bystander.username} look` });
  const [item] = await listed("bystander");
  expect(item).toMatchObject({ unreadMention: true });
  expect(changed).toContain(people.bystander.id);
});

test("Done and read-all clear it, and a newer message brings it back", async () => {
  const [item] = await listed("follower");
  await inbox.markDone(workspaceId, people.follower.id, {
    kind: "conversation",
    conversationId: item!.task!.conversationId,
    throughSequence: item!.latestSequence,
  });
  expect(await listed("follower")).toEqual([]);
  await conversations.reply(as("writer"), ref, { body: "Another" });
  expect(await listed("follower")).toHaveLength(1);

  await inbox.markAllRead(workspaceId, people.follower.id, { before: new Date() });
  expect((await listed("follower"))[0]!.unreadCount).toBe(0);
});

test("unfollowing removes it unless mentioned, and leaving the private board removes it", async () => {
  await conversations.unfollow(as("follower"), ref);
  expect(await listed("follower")).toEqual([]);
  await conversations.reply(as("writer"), ref, { body: "Nobody but the writer" });
  expect(await listed("follower")).toEqual([]);

  expect(await listed("bystander")).toHaveLength(1);
  await db.conversationMember.update({
    where: { id: people.bystander.memberId },
    data: { leftAt: new Date() },
  });
  expect(await listed("bystander")).toEqual([]);
  expect(await inbox.navAttention(workspaceId, people.bystander.id)).toEqual({ hasUnread: false });
});
