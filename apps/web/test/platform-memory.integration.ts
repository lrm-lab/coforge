import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaPlatformMemoryStore } from "#src/server/db/repositories/platform-memory.repositories.server";
import { PlatformMemory } from "#src/server/platform-memory/memory";
import type { MemoryEngine } from "#src/server/platform-memory/contract";
import type { MemoryWrite } from "@lrm/coforge-sdk/agent";

const url = Bun.env.PLATFORM_MEMORY_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "PLATFORM_MEMORY_TEST_DATABASE_URL must name a disposable, migrated PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const bodies = new Map<string, MemoryWrite>();
const engine: MemoryEngine = {
  async available() {
    return true;
  },
  async write(_ws, uri, body) {
    bodies.set(uri, body);
  },
  async read(_ws, uri) {
    const value = bodies.get(uri);
    if (!value) throw new Error("not found");
    return value;
  },
  async remove() {},
  async search() {
    return [...bodies.keys()];
  },
};
let workspaceId: string;
let userId: string;
let agentId: string;
let otherAgentId: string;
beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `memory-${crypto.randomUUID()}`, displayName: "Memory test owner" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `memory-${crypto.randomUUID()}`,
      name: "Memory test",
      experiments: { platformMemory: true },
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: "developer",
      displayName: "Developer",
      runtimeConfig: { runtime: "codex" },
    },
  });
  const other = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: "reviewer",
      displayName: "Reviewer",
      runtimeConfig: { runtime: "claude-code" },
    },
  });
  agentId = agent.id;
  otherAgentId = other.id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
const service = () => new PlatformMemory(new PrismaPlatformMemoryStore(db), engine);
const principal = () => ({ workspaceId, kind: "agent" as const, agentId });
test("real PostgreSQL references survive service recreation, share explicitly and enforce CAS", async () => {
  const command = {
    operation: "create" as const,
    scope: "agent" as const,
    requestId: crypto.randomUUID(),
    title: "Release",
    content: "Run tests",
    kind: "fact" as const,
  };
  const original = (await service().execute(principal(), command)).entries[0]!;
  expect((await service().execute(principal(), command)).entries[0]?.id).toBe(original.id);
  expect(await db.platformMemoryHead.count({ where: { workspaceId } })).toBe(1);
  const duplicate = { ...command, requestId: crypto.randomUUID() };
  expect((await service().execute(principal(), duplicate)).entries[0]?.id).toBe(original.id);
  await expect(
    service().execute(principal(), { ...duplicate, content: "Changed duplicate payload" }),
  ).rejects.toThrow("memory_conflict");
  const other = { ...principal(), agentId: otherAgentId };
  await expect(service().execute(other, { operation: "get", id: original.id })).rejects.toThrow(
    "memory_not_found",
  );
  await service().execute(principal(), {
    operation: "share",
    id: original.id,
    revision: 1,
    requestId: crypto.randomUUID(),
  });
  expect(
    (await service().execute(other, { operation: "search", query: "release" })).entries.map(
      (e) => e.scope,
    ),
  ).toEqual(["team"]);
  const update = {
    ...command,
    operation: "update" as const,
    id: original.id,
    revision: 1,
    requestId: crypto.randomUUID(),
    content: "Run tests and build",
  };
  const outcomes = await Promise.allSettled([
    service().execute(principal(), update),
    service().execute(principal(), {
      ...update,
      requestId: crypto.randomUUID(),
      content: "A competing correction",
    }),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  expect(
    (await service().execute(principal(), { operation: "get", id: original.id })).entries[0]
      ?.revision,
  ).toBe(2);
});
test("forgetting retains dedup identities before and after a correction", async () => {
  const command = {
    operation: "create" as const,
    scope: "agent" as const,
    requestId: crypto.randomUUID(),
    title: "Corrected fact",
    content: "Original value",
    kind: "fact" as const,
  };
  const entry = (await service().execute(principal(), command)).entries[0]!;
  const corrected = { ...command, content: "Corrected value" };
  await service().execute(principal(), {
    ...corrected,
    operation: "update",
    id: entry.id,
    revision: 1,
    requestId: crypto.randomUUID(),
  });
  await service().execute(principal(), {
    operation: "delete",
    id: entry.id,
    revision: 2,
    requestId: crypto.randomUUID(),
  });
  for (const content of [command.content, corrected.content])
    await expect(
      service().execute(principal(), { ...command, content, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("memory_conflict");
});
test("tombstones suppress source re-extraction, and disabling preserves existing local/engine data", async () => {
  const conversation = await db.conversation.create({
    data: { workspaceId, channelName: "memory-test", members: { create: { agentId } } },
    include: { members: true },
  });
  const source = await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      sequence: 1,
      senderMemberId: conversation.members[0]!.id,
      body: "An obsolete, saved source fact",
    },
  });
  const command = {
    operation: "create" as const,
    scope: "agent" as const,
    requestId: crypto.randomUUID(),
    sourceMessageId: source.id,
    title: "Forget me",
    content: "Obsolete rule",
    kind: "fact" as const,
  };
  await expect(
    service().execute({ ...principal(), agentId: otherAgentId }, command),
  ).rejects.toThrow("memory_forbidden");
  const original = (await service().execute(principal(), command)).entries[0]!;
  const secondSource = await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      sequence: 2,
      senderMemberId: conversation.members[0]!.id,
      body: "A corrected saved source",
    },
  });
  await service().execute(principal(), {
    ...command,
    operation: "update",
    id: original.id,
    revision: 1,
    sourceMessageId: secondSource.id,
    requestId: crypto.randomUUID(),
  });
  const deleted = {
    operation: "delete" as const,
    id: original.id,
    revision: 2,
    requestId: crypto.randomUUID(),
  };
  await service().execute(principal(), deleted);
  const { sourceMessageId: _sourceMessageId, ...withoutSource } = command;
  await expect(
    service().execute(principal(), { ...withoutSource, requestId: crypto.randomUUID() }),
  ).rejects.toThrow("memory_conflict");
  await expect(
    service().execute(principal(), {
      ...command,
      sourceMessageId: secondSource.id,
      content: "A new extraction of the replacement source",
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_conflict");
  await expect(
    service().execute(principal(), {
      ...command,
      content: "A differently worded extraction",
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_conflict");
  expect(
    (await service().execute(principal(), { operation: "search", query: "obsolete" })).entries.some(
      (e) => e.id === original.id,
    ),
  ).toBe(false);
  await db.workspace.update({
    where: { id: workspaceId },
    data: { experiments: { platformMemory: false } },
  });
  const before = bodies.size;
  expect((await service().execute(principal(), { operation: "status" })).enabled).toBe(false);
  await expect(service().execute(principal(), { operation: "list" })).rejects.toThrow(
    "memory_disabled",
  );
  expect(bodies.size).toBe(before);
});
