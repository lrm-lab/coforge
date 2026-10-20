import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";
import { resolveActorServerRole } from "#src/server/conversations/channel-authority.server";
import { PrismaAgentDetailSource } from "#src/server/db/repositories/agent-detail.repositories.server";
import { authenticateAgentHttpRequest } from "#src/server/agents/agent-api-http.server";
import { createAgentApiKey } from "#src/server/agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { createDaemonApiKeyFactory } from "#src/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { WorkspaceAssistantCommands } from "#src/server/agents/workspace-assistant-commands.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { agentMigrationRequests } from "#src/server/agent-migrations/agent-migration-composition.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { backfillWorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();
let workspace: { id: string };
let alice: { id: string };
let bob: { id: string; username: string };

beforeAll(async () => {
  [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({ data: { username: `assistant-${name}-${suffix}`, displayName: name } }),
    ),
  );
  workspace = await db.workspace.create({
    data: {
      slug: `assistant-${suffix}`,
      name: "Assistant isolation",
      members: { create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }] },
    },
  });
});

test("even an owner sees only their own assistant, while ordinary private Agent visibility stays unchanged", async () => {
  const assistants = new WorkspaceAssistants(db);
  const [a, b] = await Promise.all([
    assistants.ensure(workspace.id, alice.id),
    assistants.ensure(workspace.id, bob.id),
  ]);
  const page = await new WorkspaceMembers(db).agentPage(workspace.id, alice.id, {
    owner: "all",
    query: "",
    limit: 100,
  });
  expect(page.items.some((agent) => agent.id === a.agentId)).toBe(true);
  expect(page.items.some((agent) => agent.id === b.agentId)).toBe(false);
  const detail = new PrismaAgentDetailSource(db, { kind: "user", userId: alice.id, role: "owner" });
  await expect(detail.findAuthorized(workspace.id, b.agentId, alice.id)).rejects.toThrow(
    "AGENT_NOT_VISIBLE",
  );
});

afterAll(async () => {
  if (workspace) await db.workspace.delete({ where: { id: workspace.id } });
  await db.user.deleteMany({ where: { id: { in: [alice?.id, bob?.id].filter(Boolean) } } });
  await db.$disconnect();
});

test("members get one stable assistant each, with independent private conversations", async () => {
  const assistants = new WorkspaceAssistants(db);
  const [a, b, aAgain] = await Promise.all([
    assistants.ensure(workspace.id, alice.id),
    assistants.ensure(workspace.id, bob.id),
    assistants.ensure(workspace.id, alice.id),
  ]);
  expect(aAgain).toEqual(a);
  expect(a.agentId).not.toBe(b.agentId);
  expect(a.conversationId).not.toBe(b.conversationId);
  const conversations = new DirectConversations(db);
  expect(await conversations.authorize(workspace.id, alice.id, a.conversationId)).toEqual({
    kind: "agent",
    agentId: a.agentId,
  });
  await expect(conversations.page(workspace.id, bob.id, a.conversationId)).rejects.toThrow();
  await expect(conversations.open(workspace.id, bob.id, { agentId: a.agentId })).rejects.toThrow();
  const aList = await conversations.list(workspace.id, alice.id);
  expect(aList.conversations.some((row) => row.conversationId === a.conversationId)).toBe(true);
});

test("only the platform assistant follows its user's current Workspace role", async () => {
  const assistant = await new WorkspaceAssistants(db).ensure(workspace.id, bob.id);
  const ordinary = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: bob.id,
      name: `ordinary-${suffix}`,
      displayName: "Ordinary",
      role: "admin",
      visibility: "private",
      runtimeConfig: { runtime: "pi", provider: { kind: "default" }, model: "", reasoning: "" },
    },
  });
  await db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: bob.id } },
    data: { role: "admin" },
  });
  expect(await resolveActorServerRole(db, workspace.id, { agentId: assistant.agentId })).toBe(
    "admin",
  );
  await db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: bob.id } },
    data: { role: "member" },
  });
  expect(await resolveActorServerRole(db, workspace.id, { agentId: assistant.agentId })).toBe(
    "member",
  );
  expect(await resolveActorServerRole(db, workspace.id, { agentId: ordinary.id })).toBe("admin");
});

test("leaving the Workspace immediately disables the assistant's existing command credentials", async () => {
  const computer = await db.computer.create({
    data: {
      ownerId: bob.id,
      machineId: `assistant-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const assistant = await new WorkspaceAssistants(db).bindComputer(
    workspace.id,
    bob.id,
    computer.id,
  );
  const agentKey = await createAgentApiKey({
    agentId: assistant.agentId,
    workspaceId: workspace.id,
    ownerId: bob.id,
    computerId: computer.id,
    repository: new PrismaAgentApiKeyRepository(db),
  });
  const daemonKey = await createDaemonApiKeyFactory(new PrismaDaemonApiKeyRepository(db)).create({
    principal: { userId: bob.id },
    workspaceId: workspace.id,
    computerId: computer.id,
  });
  const request = new Request("http://localhost/api/agent/v1/manual?topic=index", {
    headers: {
      authorization: `Bearer ${daemonKey}`,
      "x-coforge-agent-api-key": `Bearer ${agentKey}`,
    },
  });
  expect((await authenticateAgentHttpRequest(request, db)).userId).toBe(bob.id);
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: bob.id } },
  });
  try {
    await expect(authenticateAgentHttpRequest(request, db)).rejects.toThrow();
    expect(
      await resolveActorServerRole(db, workspace.id, { agentId: assistant.agentId }),
    ).toBeUndefined();
    await expect(new WorkspaceAssistants(db).ensure(workspace.id, bob.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
  } finally {
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: bob.id } });
    await db.computer.delete({ where: { id: computer.id } });
  }
});

test("a platform assistant cannot be made public or deleted", async () => {
  const assistant = await new WorkspaceAssistants(db).ensure(workspace.id, alice.id);
  await expect(
    new PrismaChangeAgentVisibilityStore(db).apply({
      agentId: assistant.agentId,
      workspaceId: workspace.id,
      visibility: "public",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  expect(
    await new PrismaAgentDeletionStore(db).delete({
      agentId: assistant.agentId,
      workspaceId: workspace.id,
      deletedAt: new Date(),
    }),
  ).toEqual({ outcome: "protected" });
});

test("a newly created Workspace already has its creator's assistant in Direct messages", async () => {
  const created = await new PrismaWorkspaceCatalogStore(db).createForUser({
    userId: alice.id,
    slug: `assistant-new-${suffix}`,
    name: "New Workspace",
  });
  try {
    const list = await new DirectConversations(db).list(created.id, alice.id);
    expect(list.conversations).toHaveLength(1);
    const assistant = await new WorkspaceAssistants(db).ensure(created.id, alice.id);
    expect(list.conversations[0]?.conversationId).toBe(assistant.conversationId);
  } finally {
    await db.workspace.delete({ where: { id: created.id } });
  }
});

test("assistant commands read and post as the questioner without sharing the assistant's private chat", async () => {
  const a = await new WorkspaceAssistants(db).ensure(workspace.id, alice.id);
  const channels = new AgentChannelManagement(db);
  const created = await channels.create(
    workspace.id,
    a.agentId,
    `assistant-${suffix.slice(0, 8)}`,
    "Created by Alice's assistant",
  );
  const commands = new WorkspaceAssistantCommands(
    db,
    { execute: (_scope, persist) => persist() },
    { publish: async () => {}, publishJson: async () => {}, broadcast: async () => {} },
  );
  const principal = { workspaceId: workspace.id, agentId: a.agentId };
  const channelSent = await commands.send(principal, {
    target: created.target,
    content: "channel-marker",
    idempotencyKey: crypto.randomUUID(),
  });
  const read = await commands.read(principal, created.target, {});
  expect(
    read.messages.some(
      (message) => message.id === channelSent.id && message.body === "channel-marker",
    ),
  ).toBe(true);
  const board = new TaskBoard(db);
  await board.execute(principal, {
    operation: "create",
    target: created.target,
    title: "assistant-command-task",
    idempotencyKey: crypto.randomUUID(),
  });
  const tasks = await board.execute(principal, {
    operation: "list",
    target: created.target,
    status: "all",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(tasks.tasks?.some((task) => task.title === "assistant-command-task")).toBe(true);
  const dmSent = await commands.send(principal, {
    target: `@${bob.username}`,
    content: "dm-marker",
    idempotencyKey: crypto.randomUUID(),
  });
  const bobDms = await new DirectConversations(db).list(workspace.id, bob.id);
  const dm = bobDms.conversations.find((row) => row.lastMessage?.preview === "dm-marker");
  expect(dm).toBeDefined();
  const page = await new DirectConversations(db).page(workspace.id, bob.id, dm!.conversationId);
  expect(page.messages.some((message) => message.id === dmSent.id)).toBe(true);
  await expect(
    new DirectConversations(db).page(workspace.id, bob.id, a.conversationId),
  ).rejects.toThrow();
});

test("Workspace admins cannot migrate another person's assistant files", async () => {
  const b = await new WorkspaceAssistants(db).ensure(workspace.id, bob.id);
  await expect(
    agentMigrationRequests(db).status({ workspaceId: workspace.id, userId: alice.id }, b.agentId),
  ).rejects.toThrow("NOT_FOUND");
});

test("backfill is repeatable for existing memberships", async () => {
  const before = await db.workspaceAssistantSession.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { userId: "asc" },
    select: { agentId: true, userId: true },
  });
  await backfillWorkspaceAssistants(db);
  await backfillWorkspaceAssistants(db);
  const after = await db.workspaceAssistantSession.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { userId: "asc" },
    select: { agentId: true, userId: true },
  });
  expect(after).toEqual(before);
});

test("search, resolve and read-around retain the actual owned Agent conversation", async () => {
  const a = await new WorkspaceAssistants(db).ensure(workspace.id, alice.id);
  const ordinary = await db.agent.findFirstOrThrow({
    where: { workspaceId: workspace.id, name: `ordinary-${suffix}` },
  });
  const conversation = await new DirectConversations(db).open(workspace.id, bob.id, {
    agentId: ordinary.id,
  });
  const member = await db.conversationMember.findUniqueOrThrow({
    where: {
      conversationId_userId: { conversationId: conversation.conversationId, userId: bob.id },
    },
  });
  const seeded = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.conversationId,
      senderMemberId: member.id,
      sequence: 1,
      body: "private-search-marker",
    },
  });
  const b = await new WorkspaceAssistants(db).ensure(workspace.id, bob.id);
  const commands = new WorkspaceAssistantCommands(db);
  const principal = { workspaceId: workspace.id, agentId: b.agentId };
  const hits = await commands.search(principal, { query: "private-search-marker" });
  expect(hits.map((hit) => hit.target)).toEqual([`@${ordinary.name}`]);
  expect(
    (await commands.read(principal, hits[0]!.target, { around: seeded.id })).messages[0]?.id,
  ).toBe(seeded.id);
  expect((await commands.resolve(principal, seeded.id)).message.target).toBe(`@${ordinary.name}`);
  await db.agent.update({ where: { id: ordinary.id }, data: { deletedAt: new Date() } });
  try {
    expect(
      (await commands.read(principal, `@${ordinary.name}`, { around: seeded.id })).messages[0]?.id,
    ).toBe(seeded.id);
    await expect(
      new DirectConversations(db).authorize(workspace.id, bob.id, conversation.conversationId, {
        canSend: true,
      }),
    ).rejects.toThrow();
  } finally {
    await db.agent.update({ where: { id: ordinary.id }, data: { deletedAt: null } });
  }
  expect(
    await commands.search(
      { workspaceId: workspace.id, agentId: a.agentId },
      { query: "private-search-marker" },
    ),
  ).toEqual([]);
  await expect(
    commands.resolve({ workspaceId: workspace.id, agentId: a.agentId }, seeded.id),
  ).rejects.toThrow("NOT_FOUND");
});

test("external event drains advance independently for each member and survive re-instantiation", async () => {
  const [a, b] = await Promise.all(
    [alice, bob].map((member) => new WorkspaceAssistants(db).ensure(workspace.id, member.id)),
  );
  const target = (
    await new AgentChannelManagement(db).create(
      workspace.id,
      a!.agentId,
      `drain-${suffix.slice(0, 8)}`,
      "Drain test",
    )
  ).target;
  const commands = new WorkspaceAssistantCommands(
    db,
    { execute: (_scope, persist) => persist() },
    { publish: async () => {}, publishJson: async () => {}, broadcast: async () => {} },
  );
  const pa = { workspaceId: workspace.id, agentId: a!.agentId };
  const pb = { workspaceId: workspace.id, agentId: b!.agentId };
  const sent = [];
  for (let index = 0; index < 3; index++)
    sent.push(
      await commands.send(pa, {
        target,
        content: `drain-${index}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
  const first = await commands.check(pa, target, 2);
  expect(first.events.map((message) => message.id)).toEqual(
    sent.slice(0, 2).map((message) => message.id),
  );
  expect(first.hasMore).toBe(true);
  const second = await new WorkspaceAssistantCommands(db).check(pa, target, 2);
  expect(second.events.map((message) => message.id)).toEqual([sent[2]!.id]);
  expect(second.hasMore).toBe(false);
  expect((await commands.check(pa, target, 2)).events).toEqual([]);
  expect((await commands.check(pb, target, 10)).events.map((message) => message.id)).toEqual(
    sent.map((message) => message.id),
  );
  const extra = [];
  for (let index = 0; index < 2; index++)
    extra.push(
      await commands.send(pa, {
        target,
        content: `concurrent-${index}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
  const singleConnection = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 1 }),
  });
  try {
    const constrained = new WorkspaceAssistantCommands(singleConnection);
    const drained = await Promise.all([
      constrained.check(pa, target, 1),
      constrained.check(pa, target, 1),
    ]);
    expect(drained.flatMap((page) => page.events.map((message) => message.id)).sort()).toEqual(
      extra.map((message) => message.id).sort(),
    );
  } finally {
    await singleConnection.$disconnect();
  }
});

test("assistant uploads can accompany delegated messages, while another member's uploads cannot", async () => {
  const [a, b] = await Promise.all(
    [alice, bob].map((member) => new WorkspaceAssistants(db).ensure(workspace.id, member.id)),
  );
  const target = (
    await new AgentChannelManagement(db).create(
      workspace.id,
      a!.agentId,
      `files-${suffix.slice(0, 8)}`,
      "File test",
    )
  ).target;
  const commands = new WorkspaceAssistantCommands(
    db,
    { execute: (_scope, persist) => persist() },
    { publish: async () => {}, publishJson: async () => {}, broadcast: async () => {} },
  );
  const principal = { workspaceId: workspace.id, agentId: a!.agentId };
  const scope = await commands.target(principal, target);
  expect(
    (
      await new PrismaDirectConversationRepository(db).resolveAgentSendTarget(
        workspace.id,
        a!.agentId,
        target,
      )
    ).conversationId,
  ).toBe(scope.conversationId);
  const uploads = await Promise.all(
    [a!, b!].map((assistant) =>
      db.attachment.create({
        data: {
          workspaceId: workspace.id,
          conversationId: scope.conversationId,
          uploaderAgentId: assistant.agentId,
          objectKey: `assistant-test-${crypto.randomUUID()}`,
          fileName: "example.txt",
          contentType: "text/plain",
          sizeBytes: 5,
        },
      }),
    ),
  );
  await expect(
    commands.send(principal, {
      target,
      content: "not mine",
      attachmentIds: [uploads[1]!.id],
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  const message = await commands.send(principal, {
    target,
    content: "my file",
    attachmentIds: [uploads[0]!.id],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(
    (await commands.read(principal, target, {})).messages.find((row) => row.id === message.id)
      ?.attachments?.[0]?.id,
  ).toBe(uploads[0]!.id);
  const file = await readAuthorizedAttachment(
    db,
    {
      attachmentId: uploads[0]!.id,
      workspaceId: workspace.id,
      userId: alice.id,
      agentId: a!.agentId,
    },
    async () => {
      throw new Error("authorization must not open file storage");
    },
  );
  expect(file.attachment.id).toBe(uploads[0]!.id);
  await expect(
    readAuthorizedAttachment(db, {
      attachmentId: uploads[0]!.id,
      workspaceId: crypto.randomUUID(),
      userId: alice.id,
      agentId: a!.agentId,
    }),
  ).rejects.toThrow("NOT_FOUND");
});
