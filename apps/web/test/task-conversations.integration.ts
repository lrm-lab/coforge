import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { handleTaskViewGet } from "#src/server/tasks/task-conversation-routes.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId: string;
let channelId: string;
let channelName: string;
let taskId: string;
const agents: Record<
  "worker" | "peer" | "outsider",
  { id: string; name: string; memberId: string }
> = {} as never;
const conversations = new TaskConversations({ db, reader: "agent", dependencies: {} });
const as = (key: keyof typeof agents) => ({ workspaceId, agentId: agents[key].id });
const ref = { target: "" as string, number: 1 };

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `tconv-owner-${suffix}`, displayName: "Owner" },
  });
  channelName = `tconv-${suffix}`;
  ref.target = `#${channelName}`;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-conv-${suffix}`,
      name: "Task conversations",
      members: { create: { userId: owner.id, role: "member" } },
      agents: {
        create: ["worker", "peer", "outsider"].map((key) => ({
          name: `tconv-${key}-${suffix}`,
          displayName: key,
          ownerId: owner.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  const byKey = (key: string) => workspace.agents.find((agent) => agent.name.includes(`-${key}-`))!;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName,
      visibility: "private",
      members: { create: [{ agentId: byKey("worker").id }, { agentId: byKey("peer").id }] },
    },
    include: { members: true },
  });
  channelId = channel.id;
  for (const key of ["worker", "peer", "outsider"] as const) {
    const agent = byKey(key);
    agents[key] = {
      id: agent.id,
      name: agent.name,
      memberId: channel.members.find((member) => member.agentId === agent.id)?.id ?? "",
    };
  }
  const task = await db.task.create({
    data: {
      conversationId: channelId,
      workspaceId,
      number: 1,
      title: "A task with no message in the channel",
      creatorMemberId: agents.worker.memberId,
      ownerMemberId: agents.worker.memberId,
      status: "in_progress",
      claimedAt: new Date(),
    },
  });
  taskId = task.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

test("a task nobody has replied to has no conversation yet", async () => {
  const view = await conversations.view(as("worker"), ref, { limit: 5 });
  expect(view).toMatchObject({
    taskRef: `#${channelName}:#1`,
    conversation: { exists: false, replyCount: 0 },
    following: false,
    recentMessages: [],
  });
});

test("following is per member, and says whether anything changed", async () => {
  expect(await conversations.follow(as("peer"), ref)).toMatchObject({
    following: true,
    changed: true,
  });
  expect(await conversations.follow(as("peer"), ref)).toMatchObject({ changed: false });
  const list = await conversations.following(as("peer"));
  expect(list.map((row) => [row.taskRef, row.reason])).toEqual([[`#${channelName}:#1`, "manual"]]);
  expect(await conversations.unfollow(as("peer"), ref, "not mine")).toMatchObject({
    following: false,
    changed: true,
  });
  expect(await conversations.unfollow(as("peer"), ref)).toMatchObject({ changed: false });
  expect(await conversations.following(as("peer"))).toEqual([]);
});

test("the first reply starts the conversation, follows the replier, and wakes the other followers", async () => {
  await conversations.follow(as("peer"), ref);
  const sent = await conversations.reply(as("worker"), ref, { body: "Starting on it" });
  expect(sent.messageId).toBeString();

  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const discussion = await db.conversation.findUniqueOrThrow({
    where: { id: task.discussionConversationId! },
  });
  expect(discussion.kind).toBe("task_thread");
  const followers = await db.taskFollow.findMany({ where: { taskId } });
  expect(followers.map((f) => [f.memberId, f.reason]).sort()).toEqual(
    [
      [agents.worker.memberId, "replied"],
      [agents.peer.memberId, "manual"],
    ].sort(),
  );
  // The replier is not woken by its own reply; the follower is.
  const deliveries = await db.agentMessageDelivery.findMany({
    where: { messageId: sent.messageId },
  });
  expect(deliveries.map((d) => d.agentId)).toEqual([agents.peer.id]);

  await conversations.reply(as("peer"), ref, { body: "Thanks" });
  const again = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  expect(again.discussionConversationId).toBe(discussion.id);

  const view = await conversations.view(as("peer"), ref, { limit: 5 });
  expect(view.conversation).toEqual({ exists: true, replyCount: 2 });
  expect(view.recentMessages.map((message) => message.body)).toEqual(["Starting on it", "Thanks"]);
});

test("an Agent outside the private channel finds no such task", async () => {
  await expect(conversations.view(as("outsider"), ref, { limit: 5 })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(conversations.reply(as("outsider"), ref, { body: "hi" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(conversations.follow(as("outsider"), ref)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a reply to a task that does not exist is NOT_FOUND", async () => {
  await expect(
    conversations.reply(as("worker"), { ...ref, number: 99 }, { body: "hi" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a retried reply with the same key posts once", async () => {
  const results = new Map<string, unknown>();
  const idempotent = new TaskConversations(
    { db, reader: "agent", dependencies: {} },
    {
      execute: async (scope, persist) => {
        const key = scope.idempotencyKey;
        if (!results.has(key)) results.set(key, await persist());
        return results.get(key) as Awaited<ReturnType<typeof persist>>;
      },
    },
  );
  const before = await db.message.count({
    where: { conversation: { taskDiscussionOf: { id: taskId } } },
  });
  const first = await idempotent.reply(as("worker"), ref, { body: "once", idempotencyKey: "k1" });
  const retry = await idempotent.reply(as("worker"), ref, { body: "once", idempotencyKey: "k1" });
  expect(retry).toEqual(first);
  const after = await db.message.count({
    where: { conversation: { taskDiscussionOf: { id: taskId } } },
  });
  expect(after).toBe(before + 1);
});

test("a member who left the board can no longer reply", async () => {
  await db.conversationMember.update({
    where: { id: agents.peer.memberId },
    data: { leftAt: new Date() },
  });
  await expect(conversations.reply(as("peer"), ref, { body: "too late" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await conversations.following(as("peer"))).toEqual([]);
  await db.conversationMember.update({
    where: { id: agents.peer.memberId },
    data: { leftAt: null },
  });
});

test("a follower reads the conversation, and reading moves what is unread", async () => {
  // Earlier tests left `peer` following with messages from `worker`; start from a fresh count.
  const before = (await conversations.following(as("peer")))[0]!;
  expect(before.unread).toBeGreaterThan(0);

  const page = await conversations.read(as("peer"), ref, { unread: true });
  expect(page.messages.length).toBe(before.unread);
  expect(page.messages.every((message) => message.target === `#${channelName}:#1`)).toBe(true);
  // What peer wrote itself is consumed without being listed.
  expect(page.messages.every((message) => message.senderHandle !== agents.peer.name)).toBe(true);

  const after = (await conversations.following(as("peer")))[0]!;
  expect(after.unread).toBe(0);
  const empty = await conversations.read(as("peer"), ref, { unread: true });
  expect(empty.messages).toEqual([]);

  await conversations.reply(as("worker"), ref, { body: "one more" });
  expect((await conversations.following(as("peer")))[0]!.unread).toBe(1);
});

test("a task nobody has replied to reads as empty, and an outsider cannot read", async () => {
  const quiet = await db.task.create({
    data: {
      conversationId: channelId,
      workspaceId,
      number: 2,
      title: "Quiet",
      creatorMemberId: agents.worker.memberId,
    },
  });
  expect(await conversations.read(as("worker"), { ...ref, number: 2 }, {})).toMatchObject({
    messages: [],
    hasOlder: false,
  });
  await expect(conversations.read(as("outsider"), ref, {})).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await db.task.delete({ where: { id: quiet.id } });
});

test("an unreceived reply replays to its follower by the task it names, until the board is lost", async () => {
  const repository = new PrismaDirectConversationRepository(db);
  const pending = await repository.readPendingAgentDeliveries(workspaceId, agents.peer.id);
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.every((delivery) => delivery.target === `#${channelName}:#1`)).toBe(true);

  // A follower without a seat in the conversation is replayed to as well, and one that
  // stopped following is not.
  const discussionId = (await db.task.findUniqueOrThrow({ where: { id: taskId } }))
    .discussionConversationId!;
  const seat = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_agentId: { conversationId: discussionId, agentId: agents.peer.id } },
  });
  await db.conversationMember.update({ where: { id: seat.id }, data: { leftAt: new Date() } });
  expect((await repository.readPendingAgentDeliveries(workspaceId, agents.peer.id)).length).toBe(
    pending.length,
  );
  await conversations.unfollow(as("peer"), ref);
  expect(await repository.readPendingAgentDeliveries(workspaceId, agents.peer.id)).toEqual([]);
  await conversations.follow(as("peer"), ref);

  await db.conversationMember.update({
    where: { id: agents.peer.memberId },
    data: { leftAt: new Date() },
  });
  expect(await repository.readPendingAgentDeliveries(workspaceId, agents.peer.id)).toEqual([]);
  await db.conversationMember.update({
    where: { id: agents.peer.memberId },
    data: { leftAt: null },
  });
});

test("stopping to follow leaves a notice with the reason in the conversation, once, and wakes nobody", async () => {
  await conversations.follow(as("peer"), ref);
  const discussionId = (await db.task.findUniqueOrThrow({ where: { id: taskId } }))
    .discussionConversationId!;
  const before = await db.message.count({ where: { conversationId: discussionId } });
  await conversations.unfollow(as("peer"), ref, "not mine <@agent:x>");
  await conversations.unfollow(as("peer"), ref, "again");
  const posted = await db.message.findMany({
    where: { conversationId: discussionId },
    orderBy: { sequence: "desc" },
    take: 5,
    include: { deliveries: true },
  });
  expect(posted.length).toBe(Math.min(5, before + 1));
  expect(posted[0]).toMatchObject({
    senderMemberId: null,
    body: expect.stringContaining("stopped following this task: not mine < @agent:x>."),
  });
  expect(posted[0]!.deliveries).toEqual([]);
  await conversations.follow(as("peer"), ref);
});

test("the route answers an Agent authenticated with its owner beside it", async () => {
  // The Agent API's principal names the Agent and the user who owns it; the board refuses both.
  const authenticated = { ...as("worker"), userId: crypto.randomUUID() };
  const response = await handleTaskViewGet(
    new Request(`http://x/?channel=${encodeURIComponent(ref.target)}&task_number=1`),
    agentTaskPrincipal(authenticated),
    conversations,
    async () => true,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ taskRef: `#${channelName}:#1` });
});
