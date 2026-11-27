import {
  agentReadPageResponseSchema,
  agentReadConfirmResponseSchema,
} from "@lrm/coforge-sdk/agent";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";

import {
  handleAgentReadConfirm,
  handleAgentReadPage,
} from "#src/server/agents/agent-read-routes.server";
import { AgentReads } from "#src/server/agents/agent-reads.server";
import type { ReadConfirmation } from "#src/server/agents/agent-read-receipts.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const name = `read-confirm-${crypto.randomUUID().slice(0, 8)}`;
let workspaceId: string;
let userId: string;
let agentId: string;

beforeAll(async () => {
  const owner = await db.user.create({ data: { username: name, displayName: "Owner" } });
  userId = owner.id;
  const workspace = await db.workspace.create({ data: { slug: name, name } });
  workspaceId = workspace.id;
  await db.workspaceMembership.create({ data: { workspaceId, userId, role: "owner" } });
  const agent = await db.agent.create({
    data: { workspaceId, name, displayName: "Reader", ownerId: userId, runtimeConfig: {} },
  });
  agentId = agent.id;
});

afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

async function conversation() {
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `read-${crypto.randomUUID().slice(0, 8)}`,
      lastSequence: 5,
      members: { create: [{ agentId }, { userId }] },
    },
    include: { members: true },
  });
  const reader = channel.members.find((m) => m.agentId === agentId)!;
  const sender = channel.members.find((m) => m.userId === userId)!;
  const messages = await db.message.createManyAndReturn({
    data: [
      { sequence: 1, senderMemberId: sender.id },
      { sequence: 2, senderMemberId: reader.id },
      { sequence: 3, senderMemberId: sender.id },
      { sequence: 4, senderMemberId: null },
      { sequence: 5, senderMemberId: sender.id },
    ].map((row) => ({ ...row, workspaceId, conversationId: channel.id, body: "Fixture" })),
  });
  return {
    channel,
    reader,
    messages,
    readThrough: async () =>
      (await db.conversationMember.findUniqueOrThrow({ where: { id: reader.id } }))
        .agentReadThroughSequence,
  };
}

test("a candidate page reports safe filtered spans before advancing any cursor", async () => {
  const { channel, readThrough } = await conversation();
  const input = {
    workspaceId,
    agentId,
    conversationId: channel.id,
    threadRootId: null,
    canonicalTarget: `#${channel.channelName}`,
    isChannel: true,
    isUserAgentDirectConversation: false,
    page: { unread: true, limit: 4 },
    resolveAnchor: async () => {
      throw new AppError("NOT_FOUND");
    },
    receiptCandidate: true,
  };
  const page = await readAgentMessagePage(db, input);
  expect(await readThrough()).toBe(0);
  expect(page.modelSeenUpToSeq).toBeNull();
  expect(page.messages.map(({ sequence }) => sequence)).toEqual([1, 3]);
  expect(page.receiptCandidate).toMatchObject({ readThrough: 0, checkpoints: [2, 4] });

  const legacy = await readAgentMessagePage(db, { ...input, receiptCandidate: false });
  expect(legacy.modelSeenUpToSeq).toBe(4);
  expect(await readThrough()).toBe(4);
});

const principal = () => ({ workspaceId, agentId });
const sourceOf = (channel: { channelName: string | null }) =>
  ({ kind: "message", target: `#${channel.channelName}` }) as const;
const createReads = (now = Date.now) => new AgentReads(db, "test-signing-value", now);
const post = (action: "page" | "confirm", body: object) =>
  new Request(`http://127.0.0.1/api/agent/v1/reads/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

test("a missing or altered middle proof cannot consume a page; a partial confirmation can piggyback", async () => {
  const { channel, readThrough } = await conversation();
  const source = sourceOf(channel);
  const service = createReads();
  const request = { source, window: { unread: true } };
  const reply = await handleAgentReadPage(post("page", request), principal(), service);
  expect(reply.headers.get("Cache-Control")).toBe("no-store");
  const page = agentReadPageResponseSchema.parse(await reply.json());
  expect(page).toMatchObject({ protocol: "consume-confirm-v1", readThrough: 0 });
  expect(page.window.messages.map((m: { sequence: number }) => m.sequence)).toEqual([1, 3, 5]);
  const receipt: ReadConfirmation = page.receipt!;
  expect(receipt.checkpoints.map(({ through }) => through)).toEqual([2, 4, 5]);
  expect(receipt.checkpoints.map(({ messageId }) => messageId)).toEqual(
    page.window.messages.map((m: { id: string }) => m.id),
  );
  expect(await readThrough()).toBe(0);

  const [first, second, last] = receipt.checkpoints;
  const anotherPage = await service.page(principal(), source, { unread: true });
  for (const checkpoints of [
    [],
    [last!],
    [first!, last!],
    [second!, first!],
    [{ ...first!, through: 5 }],
    [{ ...first!, messageId: second!.messageId }],
    [anotherPage.receipt!.checkpoints[0]!],
  ]) {
    const response = await handleAgentReadConfirm(
      post("confirm", { ...receipt, checkpoints }),
      principal(),
      service,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await readThrough()).toBe(0);
  }
  const prefix = { ...receipt, checkpoints: [first!] };
  const continued = await handleAgentReadPage(
    post("page", { ...request, confirm: prefix }),
    principal(),
    service,
  );
  const next = agentReadPageResponseSchema.parse(await continued.json());
  expect(next).toMatchObject({
    readThrough: 2,
    confirmation: {
      readThrough: 2,
      scope: { agentId, conversationId: channel.id, target: source.target, channelType: "channel" },
    },
  });
  expect(next.window.messages.map((m: { sequence: number }) => m.sequence)).toEqual([3, 5]);
  expect(await readThrough()).toBe(2);

  await Promise.all([
    service.confirm(principal(), prefix),
    service.confirm(principal(), receipt),
    service.confirm(principal(), receipt),
  ]);
  expect(await readThrough()).toBe(5);
  expect(await service.confirm(principal(), prefix)).toMatchObject({ readThrough: 5 });
});

test("pure views, non-contiguous windows and empty latest pages issue no receipt", async () => {
  const { channel, messages, reader, readThrough } = await conversation();
  const source = sourceOf(channel);
  const service = createReads();
  for (const window of [
    { consume: false, unread: true },
    { around: messages[2]!.id },
    { after: messages[2]!.id },
    { fromSequence: 3 },
    { throughSequence: 4 },
    { limit: 1 },
  ]) {
    const page = await service.page(principal(), source, window);
    expect(page.receipt).toBeUndefined();
    expect(await readThrough()).toBe(0);
  }
  await db.conversationMember.update({
    where: { id: reader.id },
    data: { agentReadThroughSequence: 5 },
  });
  expect(await service.page(principal(), source, { unread: true })).toMatchObject({
    readThrough: 5,
    window: { messages: [] },
  });
  expect((await service.page(principal(), source, { unread: true })).receipt).toBeUndefined();
});

test("filtered-only receipts may advance once and expiry, revoked scope and old base reject", async () => {
  const { channel, reader, readThrough } = await conversation();
  const source = sourceOf(channel);
  let now = 1000;
  const service = createReads(() => now);
  await db.conversationMember.update({
    where: { id: reader.id },
    data: { agentReadThroughSequence: 1 },
  });
  const filtered = await service.page(principal(), source, { unread: true, limit: 1 });
  expect(filtered.window.messages).toEqual([]);
  expect(filtered.receipt?.checkpoints).toMatchObject([{ index: 1, through: 2 }]);
  expect(filtered.receipt?.checkpoints[0]?.messageId).toBeUndefined();
  expect(await readThrough()).toBe(1);
  const valid = filtered.receipt!;

  await expect(service.confirm({ ...principal(), agentId: userId }, valid)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    service.confirm({ ...principal(), workspaceId: userId }, valid),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  const other = sourceOf((await conversation()).channel);
  await expect(service.page(principal(), other, { unread: true }, valid)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  now += 600_000;
  await expect(service.confirm(principal(), valid)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  now -= 600_000;
  await db.conversationMember.update({
    where: { id: reader.id },
    data: { agentReadThroughSequence: 0 },
  });
  await expect(service.confirm(principal(), valid)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readThrough()).toBe(0);
  await db.conversationMember.update({
    where: { id: reader.id },
    data: { agentReadThroughSequence: 1, leftAt: new Date() },
  });
  await expect(service.confirm(principal(), valid)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  expect(await readThrough()).toBe(1);
  await db.conversationMember.update({ where: { id: reader.id }, data: { leftAt: null } });
  expect(await service.confirm(principal(), valid)).toMatchObject({ readThrough: 2 });
  expect(await readThrough()).toBe(2);
});

test("a task discussion uses its board permission and can confirm its first read without a prior seat", async () => {
  const { channel, reader } = await conversation();
  const discussion = await db.conversation.create({
    data: { workspaceId, kind: "task_thread", lastSequence: 3, members: { create: { userId } } },
    include: { members: true },
  });
  const task = await db.task.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      discussionConversationId: discussion.id,
      creatorMemberId: reader.id,
      title: "Confirm the discussion",
      number: 1,
    },
  });
  await db.message.createMany({
    data: [1, 2, 3].map((sequence) => ({
      workspaceId,
      conversationId: discussion.id,
      senderMemberId: discussion.members[0]!.id,
      sequence,
      body: `Discussion ${sequence}`,
    })),
  });
  const source = {
    kind: "task",
    channel: `#${channel.channelName}`,
    taskNumber: task.number,
  } as const;
  const service = createReads();
  const membership = () =>
    db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId: discussion.id, agentId } },
    });
  const reply = await handleAgentReadPage(
    post("page", { source, window: { unread: true } }),
    principal(),
    service,
  );
  expect(reply.status).toBe(200);
  const page = agentReadPageResponseSchema.parse(await reply.json());
  expect(await membership()).toBeNull();
  expect(page.window.messages.map((message) => message.sequence)).toEqual([1, 2, 3]);

  const receipt = page.receipt!;
  const prefix = { ...receipt, checkpoints: receipt.checkpoints.slice(0, 1) };
  const result = await handleAgentReadConfirm(post("confirm", prefix), principal(), service);
  expect(result.status).toBe(200);
  expect(agentReadConfirmResponseSchema.parse(await result.json())).toMatchObject({
    protocol: "consume-confirm-v1",
    confirmation: {
      scope: {
        agentId,
        conversationId: discussion.id,
        target: `#${channel.channelName}:#1`,
        channelType: "thread",
      },
      readThrough: 1,
    },
  });
  expect((await membership())?.agentReadThroughSequence).toBe(1);
  expect(
    (await service.page(principal(), source, { unread: true })).window.messages.map(
      ({ sequence }) => sequence,
    ),
  ).toEqual([2, 3]);

  await db.conversationMember.update({ where: { id: reader.id }, data: { leftAt: new Date() } });
  await expect(service.confirm(principal(), receipt)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await membership())?.agentReadThroughSequence).toBe(1);
});

test("normal thread confirmations advance only that thread across conversation-wide sequence gaps", async () => {
  const { channel, messages, reader, readThrough } = await conversation();
  const root = messages.find(({ sequence }) => sequence === 1)!;
  await db.message.updateMany({
    where: { conversationId: channel.id, sequence: { in: [3, 5] } },
    data: { threadRootId: root.id },
  });
  const source = { kind: "message", target: `#${channel.channelName}:${root.id}` } as const;
  const service = createReads();
  const page = await service.page(principal(), source, { unread: true });
  expect(page.window.messages.map(({ sequence }) => sequence)).toEqual([3, 5]);
  expect(page.receipt?.checkpoints.map(({ through }) => through)).toEqual([3, 5]);
  const threadRead = () =>
    db.threadRead.findUnique({
      where: { memberId_rootMessageId: { memberId: reader.id, rootMessageId: root.id } },
    });
  expect(await threadRead()).toBeNull();
  await expect(service.confirm(principal(), page.receipt!)).resolves.toMatchObject({
    readThrough: 5,
    scope: { threadRootId: root.id, conversationId: channel.id, channelType: "thread" },
  });
  expect((await threadRead())?.readThroughSequence).toBe(5);
  expect(await readThrough()).toBe(0);
});
