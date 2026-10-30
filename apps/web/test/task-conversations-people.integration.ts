import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let boardId = "";
let taskId = "";
const people = {} as Record<
  "writer" | "friend",
  { id: string; username: string; memberId: string }
>;
const agent = { id: "", name: "", memberId: "" };
const conversations = new TaskConversations({ db, reader: "people", dependencies: {} });
const as = (key: keyof typeof people) => ({ workspaceId, userId: people[key].id });
const ref = () => ({ conversationId: boardId, number: 1 });

beforeAll(async () => {
  const users = await Promise.all(
    (["writer", "friend"] as const).map((key) =>
      db.user.create({ data: { username: `tcpl-${key}-${suffix}`, displayName: key } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-conv-people-${suffix}`,
      name: "Task conversations, people",
      members: { create: users.map((user) => ({ userId: user.id, role: "member" })) },
      agents: {
        create: {
          name: `tcpl-agent-${suffix}`,
          displayName: "helper",
          ownerId: users[0]!.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  const board = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tcpl-${suffix}`,
      members: {
        create: [
          ...users.map((user) => ({ userId: user.id })),
          { agentId: workspace.agents[0]!.id },
        ],
      },
    },
    include: { members: true },
  });
  boardId = board.id;
  for (const [index, key] of (["writer", "friend"] as const).entries())
    people[key] = {
      id: users[index]!.id,
      username: users[index]!.username,
      memberId: board.members.find((member) => member.userId === users[index]!.id)!.id,
    };
  Object.assign(agent, {
    id: workspace.agents[0]!.id,
    name: workspace.agents[0]!.name,
    memberId: board.members.find((member) => member.agentId === workspace.agents[0]!.id)!.id,
  });
  const task = await db.task.create({
    data: {
      conversationId: boardId,
      workspaceId,
      number: 1,
      title: "talk about it",
      creatorMemberId: people.writer.memberId,
    },
  });
  taskId = task.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({
    where: { id: { in: [people.writer.id, people.friend.id] } },
  });
  await db.$disconnect();
});

const followOf = (memberId: string) =>
  db.taskFollow.findUnique({ where: { memberId_taskId: { memberId, taskId } } });

test("a person's reply stores the people it mentions as tokens and follows them", async () => {
  const sent = await conversations.reply(as("writer"), ref(), {
    body: `@${people.friend.username} what do you think?`,
  });
  const message = await db.message.findUniqueOrThrow({
    where: { id: sent.messageId },
    include: { mentions: true },
  });
  expect(message.body).toBe(`<@human:${people.friend.id}> what do you think?`);
  expect(message.mentions.map((mention) => [mention.kind, mention.actorId])).toEqual([
    ["user", people.friend.id],
  ]);
  expect((await followOf(people.writer.memberId))?.reason).toBe("replied");
  expect((await followOf(people.friend.memberId))?.reason).toBe("mentioned");
});

test("an Agent that is mentioned follows and is delivered the message, though it follows nothing yet", async () => {
  expect(await followOf(agent.memberId)).toBeNull();
  const sent = await conversations.reply(as("friend"), ref(), {
    body: `@${agent.name} can you take this?`,
  });
  expect((await followOf(agent.memberId))?.reason).toBe("mentioned");
  const deliveries = await db.agentMessageDelivery.findMany({
    where: { messageId: sent.messageId },
  });
  expect(deliveries.map((delivery) => delivery.agentId)).toEqual([agent.id]);
});

test("stopping to follow, then being mentioned again, follows again", async () => {
  await conversations.unfollow(as("friend"), ref());
  expect(await followOf(people.friend.memberId)).toBeNull();
  await conversations.reply(as("writer"), ref(), {
    body: `@${people.friend.username} one more thing`,
  });
  expect((await followOf(people.friend.memberId))?.reason).toBe("mentioned");
});

test("uploads are a person's: an Agent cannot attach, and another person's file is refused", async () => {
  await expect(
    conversations.reply(
      { workspaceId, agentId: agent.id },
      { ...ref(), target: undefined },
      {
        body: "with a file",
        attachmentIds: [crypto.randomUUID()],
      },
    ),
  ).rejects.toMatchObject({ code: expect.any(String) });
  await expect(
    conversations.reply(as("writer"), ref(), {
      body: "with a file",
      attachmentIds: [crypto.randomUUID()],
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("an empty or oversized body is refused", async () => {
  await expect(conversations.reply(as("writer"), ref(), { body: "  " })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    conversations.reply(as("writer"), ref(), { body: "x".repeat(64_001) }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("opening the conversation seats the person without a message or a follow", async () => {
  const before = await db.taskFollow.count({ where: { memberId: people.friend.memberId } });
  const { conversationId } = await conversations.open(as("friend"), ref());
  expect(await conversations.open(as("friend"), ref())).toEqual({ conversationId });
  const seat = await db.conversationMember.findFirst({
    where: { conversationId, userId: people.friend.id, leftAt: null },
  });
  expect(seat).not.toBeNull();
  expect(await db.taskFollow.count({ where: { memberId: people.friend.memberId } })).toBe(before);
});

test("a deleted Agent that is mentioned does not follow the task", async () => {
  await db.taskFollow.deleteMany({ where: { taskId, memberId: agent.memberId } });
  await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
  await conversations.reply(as("friend"), ref(), { body: `@${agent.name} still there?` });
  expect(await followOf(agent.memberId)).toBeNull();
  await db.agent.update({ where: { id: agent.id }, data: { deletedAt: null } });
});

test("a reply is announced to the pages open on the conversation, and reading moves the person's count", async () => {
  const announced: Array<{ conversationId: string; sequence: number }> = [];
  const live = new TaskConversations({
    db,
    reader: "people",
    dependencies: {
      realtime: {
        messageAvailable: async (input: { conversationId: string; sequence: number }) => {
          announced.push(input);
        },
      } as never,
    },
  });
  const sent = await live.reply(as("writer"), ref(), { body: "Anyone looking at this?" });
  const message = await db.message.findUniqueOrThrow({ where: { id: sent.messageId } });
  expect(announced).toEqual([
    expect.objectContaining({ conversationId: message.conversationId, sequence: message.sequence }),
  ]);

  expect(await live.markRead(as("friend"), ref(), message.sequence)).toEqual({ unreadCount: 0 });
  expect(await live.markRead(as("friend"), ref(), message.sequence)).toBeNull();
  await expect(live.markRead(as("friend"), ref(), 0)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});

test("whether a person follows a task reads before there is any conversation", async () => {
  const quiet = await db.task.create({
    data: {
      conversationId: boardId,
      workspaceId,
      number: 9,
      title: "Quiet",
      creatorMemberId: people.writer.memberId,
    },
  });
  const quietRef = { conversationId: boardId, number: 9 };
  expect(await conversations.followState(as("friend"), quietRef)).toEqual({ following: false });
  await conversations.follow(as("friend"), quietRef);
  expect(await conversations.followState(as("friend"), quietRef)).toEqual({ following: true });
  await db.task.delete({ where: { id: quiet.id } });
});
