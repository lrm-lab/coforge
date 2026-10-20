import { WorkspaceJoinLinks } from "#src/server/workspaces/join-links.server";
import { PrismaWorkspaceJoinLinkStore } from "#src/server/workspaces/join-links-store.server";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { WorkspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { createAgentIntroduction } from "#src/server/db/repositories/agent-introduction.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();
let workspaceId: string;
let userId: string;
let computerId: string;
let agentId: string;
let conversationId: string;
const extraUsers: string[] = [];
let starts = 0;
let cloudStarts = 0;
const onboarding = new WorkspaceAssistantOnboarding(db, {
  startCloudComputer: async () => {
    cloudStarts++;
    await db.workspaceComputer.upsert({
      where: { workspaceId_computerId: { workspaceId, computerId } },
      create: { workspaceId, computerId },
      update: {},
    });
    return { slot: "default", computerId };
  },
  startAgent: async () => {
    starts++;
  },
});

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `onboard-${suffix}`, displayName: "Onboarding" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Assistant onboarding",
      slug: `onboard-${suffix}`,
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  await db.computer.create({
    data: {
      ownerId: userId,
      machineId: `local-${suffix}`,
      workspaces: { create: { workspaceId } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: userId,
      machineId: `onboard-${suffix}`,
      name: "Cloud",
      kind: "cloud",
      cloudSlot: "default",
    },
  });
  computerId = computer.id;
});

test("provisioning starts a private Pi assistant on the default cloud computer without a user message", async () => {
  const result = await onboarding.ensure(workspaceId, userId);
  agentId = result.agentId;
  conversationId = result.conversationId;
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  expect(agent.computerId).toBe(computerId);
  expect(agent.runtimeConfig).toEqual({
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  });
  expect(agent.introductionDueAt).toBeInstanceOf(Date);
  expect(starts).toBe(1);
  expect(cloudStarts).toBe(1);
  const controlAgent = await new PrismaAgentControlStore(db).get(agentId);
  const prompt = await createAgentIntroduction(db).promptFor(controlAgent!, new Date());
  expect(prompt).toContain("CoForge platform assistant");
  expect(prompt).toContain("coforge message send");
});

test("a transport failure leaves the same pending assistant available for retry", async () => {
  const failing = new WorkspaceAssistantOnboarding(db, {
    startCloudComputer: async () => {
      throw new Error("unexpected cloud allocation");
    },
    startAgent: async () => {
      throw new Error("transport unavailable");
    },
  });
  expect((await failing.ensure(workspaceId, userId)).agentId).toBe(agentId);
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).introductionDueAt,
  ).not.toBeNull();
  const before = starts;
  await onboarding.ensure(workspaceId, userId);
  expect(starts).toBe(before + 1);
});

test("old assistants without any reply are enrolled once, even after seven days offline", async () => {
  const old = new Date(Date.now() - 30 * 86_400_000);
  await db.agent.update({
    where: { id: agentId },
    data: { createdAt: old, introductionDueAt: null },
  });
  await onboarding.ensure(workspaceId, userId);
  const agent = await new PrismaAgentControlStore(db).get(agentId);
  expect(agent?.introductionDueAt).toEqual(old);
  expect(await createAgentIntroduction(db).promptFor(agent!, new Date())).toContain(
    "CoForge platform assistant",
  );
});

test("stopped assistants stay stopped during onboarding and repeated backfill", async () => {
  await db.agent.update({ where: { id: agentId }, data: { stoppedAt: new Date() } });
  const before = starts;
  await onboarding.ensure(workspaceId, userId);
  expect(starts).toBe(before);
  await db.agent.update({ where: { id: agentId }, data: { stoppedAt: null } });
});

test("a real canonical welcome settles introduction and enables choices only until the member replies", async () => {
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, agentId },
  });
  await db.message.create({
    data: {
      conversationId,
      workspaceId,
      senderMemberId: member.id,
      sequence: 1,
      body: "你好，我是通用助手。",
    },
  });
  const before = starts;
  await onboarding.ensure(workspaceId, userId);
  await onboarding.ensure(workspaceId, userId);
  expect(starts).toBe(before);
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).introductionDueAt,
  ).toBeNull();
  const page = await new DirectConversations(db).page(workspaceId, userId, conversationId);
  expect(page.workspaceAssistantWelcome).toBe(true);
  const sender = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, userId },
  });
  await db.message.create({
    data: {
      conversationId,
      workspaceId,
      senderMemberId: sender.id,
      sequence: 2,
      body: "帮我了解平台功能",
    },
  });
  expect(
    (await new DirectConversations(db).page(workspaceId, userId, conversationId))
      .workspaceAssistantWelcome,
  ).toBeUndefined();
  await new WorkspaceAssistants(db).ensure(workspaceId, userId);
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).introductionDueAt,
  ).toBeNull();
});

test("joining by link provisions and starts the assistant after membership commits, without loading Chat", async () => {
  const visitor = await db.user.create({
    data: { username: `visitor-${suffix}`, displayName: "Visitor" },
  });
  extraUsers.push(visitor.id);
  let started = false;
  const welcome = new WorkspaceAssistantOnboarding(db, {
    startCloudComputer: async () => {
      const computer = await db.computer.create({
        data: {
          ownerId: visitor.id,
          machineId: `cloud-${suffix}`,
          kind: "cloud",
          cloudSlot: "default",
          workspaces: { create: { workspaceId } },
        },
      });
      return { slot: "default", computerId: computer.id };
    },
    startAgent: async ({ userId: memberId }) => {
      expect(memberId).toBe(visitor.id);
      expect(
        await db.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: memberId } },
        }),
      ).not.toBeNull();
      started = true;
    },
  });
  const links = new WorkspaceJoinLinks(
    new PrismaWorkspaceJoinLinkStore(db),
    undefined,
    undefined,
    (workspaceId, userId) => welcome.ensure(workspaceId, userId),
  );
  const link = await links.create({
    workspaceId,
    actorUserId: userId,
    maxUses: null,
    expiresAt: null,
  });
  await links.join({ token: link.token, userId: visitor.id });
  expect(started).toBe(true);
  expect(
    await db.workspaceAssistantSession.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: visitor.id } },
    }),
  ).not.toBeNull();
});

afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) {
    await db.computer.deleteMany({ where: { ownerId: userId } });
    await db.user.delete({ where: { id: userId } });
  }
  await db.computer.deleteMany({ where: { ownerId: { in: extraUsers } } });
  await db.user.deleteMany({ where: { id: { in: extraUsers } } });
  await db.$disconnect();
});
