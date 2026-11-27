import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { handleTaskReplyPost } from "#src/server/tasks/task-conversation-routes.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

let fixtureSlug: string;
let ownerId: string;
afterAll(async () => {
  try {
    if (fixtureSlug) await db.workspace.deleteMany({ where: { slug: fixtureSlug } });
    if (ownerId) await db.user.delete({ where: { id: ownerId } });
  } finally {
    await db.$disconnect();
  }
});

test("task reply holds unread context without consuming it, then resumes only the same task", async () => {
  const number = 1;
  const channelName = `task-hold-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await db.user.create({
    data: { username: channelName, displayName: "Task owner" },
  });
  fixtureSlug = channelName;
  ownerId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      slug: channelName,
      name: "Task reply hold",
      members: { create: { userId: owner.id, role: "member" } },
    },
  });
  const workspaceId = workspace.id;
  const worker = await db.agent.create({
    data: {
      workspaceId,
      name: channelName,
      displayName: "Task Agent",
      ownerId: owner.id,
      runtimeConfig: {},
    },
  });
  const board = await db.conversation.create({
    data: {
      workspaceId,
      channelName,
      visibility: "private",
      members: { create: [{ agentId: worker.id }, { userId: owner.id }] },
    },
    include: { members: true },
  });
  const principal = { workspaceId, agentId: worker.id };
  const peer = { workspaceId, userId: owner.id };
  const peerRef = { conversationId: board.id, number };
  const target = { target: `#${channelName}`, number };
  const task = await db.task.create({
    data: {
      workspaceId,
      conversationId: board.id,
      number,
      title: "Test task reply hold",
      creatorMemberId: board.members.find((member) => member.agentId === worker.id)!.id,
    },
  });
  const redis = openRedisClient(Bun.env.REDIS_URL ?? "redis://127.0.0.1:16379");
  const guarded = new TaskConversations(
    { db, reader: "agent", dependencies: {} },
    new RedisMessageRequestIdempotency(redis),
  );
  const reply = (body: Record<string, unknown>) =>
    handleTaskReplyPost(
      new Request("http://localhost/tasks/reply", {
        method: "POST",
        body: JSON.stringify({ channel: target.target, task_number: number, ...body }),
      }),
      principal,
      guarded,
    );
  try {
    const first = await guarded.reply(peer, peerRef, { body: "Unread context" });
    const discussion = await db.task.findUniqueOrThrow({
      where: { id: task.id },
      select: { discussionConversationId: true },
    });
    const conversationId = discussion.discussionConversationId!;
    const cursor = async () =>
      (
        await db.conversationMember.findUnique({
          where: { conversationId_agentId: { conversationId, agentId: worker.id } },
          select: { agentReadThroughSequence: true },
        })
      )?.agentReadThroughSequence ?? 0;

    const content = { content: "My reply", idempotencyKey: "held-reply" };
    expect(await (await reply({ ...content, holdIfUnread: true })).json()).toMatchObject({
      state: "held",
      taskId: task.id,
      newMessageCount: 1,
      heldMessages: [{ sequence: first.sequence, body: "Unread context" }],
    });
    expect(await db.message.count({ where: { conversationId } })).toBe(1);
    expect(await cursor()).toBe(0);

    await guarded.read(principal, target, { unread: true });
    expect(await cursor()).toBe(first.sequence);
    const resume = (taskId: string, anyway: boolean) => ({
      ...content,
      task_number: 0,
      resume: { number, taskId, anyway },
    });
    expect((await reply(resume(crypto.randomUUID(), false))).status).toBe(404);
    const sent = await (await reply(resume(task.id, false))).json();
    expect(sent).toMatchObject({ messageId: expect.any(String), idempotencyKey: "held-reply" });
    expect(await cursor()).toBe(first.sequence);

    await guarded.reply(peer, peerRef, { body: "New unread context" });
    expect(await (await reply(resume(task.id, false))).json()).toEqual(sent);
    expect(
      await (await reply({ ...resume(task.id, false), idempotencyKey: "new" })).json(),
    ).toMatchObject({ state: "held", newMessageCount: 1 });
    expect(
      await (await reply({ ...resume(task.id, true), idempotencyKey: "new" })).json(),
    ).toMatchObject({ messageId: expect.any(String) });
    expect(await (await reply({ ...content, idempotencyKey: "legacy" })).json()).toMatchObject({
      messageId: expect.any(String),
    });
    expect(await cursor()).toBe(first.sequence);
    expect(await db.message.count({ where: { conversationId } })).toBe(5);
  } finally {
    redis.close();
  }
});
