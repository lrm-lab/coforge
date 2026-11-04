import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId: string;
let channelId: string;
let channelName: string;
const agents: Record<"worker" | "peer" | "outsider", { id: string; memberId: string }> =
  {} as never;

afterAll(() => db.$disconnect());
beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `tconv-owner-${suffix}`, displayName: "Owner" },
  });
  channelName = `tconv-${suffix}`;
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
      memberId: channel.members.find((member) => member.agentId === agent.id)?.id ?? "",
    };
  }
});

const taskWithDiscussion = async (number: number, conversationId = channelId) => {
  const discussion = await db.conversation.create({
    data: { workspaceId, kind: "task_thread" },
  });
  const task = await db.task.create({
    data: {
      conversationId,
      workspaceId,
      number,
      title: `task ${number}`,
      creatorMemberId: agents.worker.memberId,
      ownerMemberId: agents.worker.memberId,
      status: "in_progress",
      discussionConversationId: discussion.id,
    },
  });
  return { task, discussion };
};
const direct = () => new PrismaDirectConversationRepository(db);

// task #522: `#channel:<task-discussion id>` resolves a Task's own `task_thread` on the read
// path only — the board channel names the `#` name, the Agent is an active member of it, and
// its seat is a read-position convenience only.
test("a channel member Agent reads the task discussion by `#channel:<discussion id>`", async () => {
  const { task, discussion } = await taskWithDiscussion(522);
  const repo = direct();
  const resolved = await repo.resolveAgentTarget(
    workspaceId,
    agents.worker.id,
    `#${channelName}:${discussion.id}`,
  );
  expect(resolved.conversationId).toBe(discussion.id);
  expect(resolved.threadRootId).toBeNull();
  expect(resolved.canonicalTarget).toBe(`#${channelName}:${discussion.id}`);
  await expect(
    repo.resolveAgentTarget(workspaceId, agents.outsider.id, `#${channelName}:${discussion.id}`),
  ).rejects.toThrow(/not found|NOT_FOUND/i);
  await db.conversationMember.updateMany({
    where: { conversationId: channelId, agentId: agents.worker.id },
    data: { leftAt: new Date() },
  });
  await expect(
    repo.resolveAgentTarget(workspaceId, agents.worker.id, `#${channelName}:${discussion.id}`),
  ).rejects.toThrow(/not found|NOT_FOUND/i);
  await db.conversationMember.updateMany({
    where: { conversationId: channelId, agentId: agents.worker.id },
    data: { leftAt: null },
  });
  // `#other:<id>` does not resolve — the board's channel is `#${channelName}`, not `#other`,
  // and the worker is not a member of `#other` either.
  await expect(
    repo.resolveAgentTarget(workspaceId, agents.worker.id, `#other:${discussion.id}`),
  ).rejects.toThrow(/not found|NOT_FOUND|ACCESS_DENIED/i);
  await expect(
    repo.resolveAgentTarget(
      workspaceId,
      agents.worker.id,
      `#${channelName}:${"00000000-0000-0000-0000-000000000000"}`,
    ),
  ).rejects.toThrow(/not found|NOT_FOUND/i);
  await db.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
  await expect(
    repo.resolveAgentTarget(workspaceId, agents.worker.id, `#${channelName}:${discussion.id}`),
  ).rejects.toThrow(/not found|NOT_FOUND/i);
  await db.task.update({ where: { id: task.id }, data: { deletedAt: null } });
});

test("a member Agent with no discussion seat reads the discussion's messages", async () => {
  const { discussion } = await taskWithDiscussion(523);
  const sender = await db.conversationMember.create({
    data: { conversationId: discussion.id, workspaceId, agentId: agents.peer.id },
  });
  await db.message.create({
    data: {
      conversationId: discussion.id,
      workspaceId,
      senderMemberId: sender.id,
      sequence: 1,
      body: "the discussion's first reply",
    },
  });
  const page = await direct().readMessagesPage(
    workspaceId,
    agents.worker.id,
    `#${channelName}:${discussion.id}`,
    { limit: 10 },
  );
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]!.body).toContain("the discussion's first reply");
  expect(
    await db.conversationMember.count({
      where: { conversationId: discussion.id, agentId: agents.worker.id },
    }),
  ).toBe(0);
});

test("a member-less Agent's read on a channel is still refused at the seat check", async () => {
  // `seatOptional` applies only to a task discussion — bypassing resolution to the history read
  // itself, a member-less Agent on an ordinary channel still hits "not a conversation member".
  await expect(
    readAgentMessagePage(db, {
      workspaceId,
      agentId: agents.outsider.id,
      conversationId: channelId,
      threadRootId: null,
      canonicalTarget: `#${channelName}`,
      isChannel: true,
      isUserAgentDirectConversation: false,
      page: { limit: 5 },
      resolveAnchor: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow(/not a conversation member/i);
});

test("a bare `#channel` or short anchor is not resolved as a task discussion", async () => {
  const repo = direct();
  const channel = await repo.resolveAgentTarget(workspaceId, agents.worker.id, `#${channelName}`);
  expect(channel.conversationId).toBe(channelId);
  await expect(
    repo.resolveAgentTarget(workspaceId, agents.worker.id, `#${channelName}:deadbeef`),
  ).rejects.toThrow(/not found|NOT_FOUND/i);
});

test("the send path does not resolve a task discussion id", async () => {
  const { discussion } = await taskWithDiscussion(525);
  await expect(
    direct().resolveAgentSendTarget(
      workspaceId,
      agents.worker.id,
      `#${channelName}:${discussion.id}`,
    ),
  ).rejects.toThrow(/not found|NOT_FOUND|anchor/i);
});
