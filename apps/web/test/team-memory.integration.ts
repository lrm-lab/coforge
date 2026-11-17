import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import type { TeamMemoryWrite } from "@lrm/coforge-sdk/agent";
import { Experiments } from "#src/server/experiments/experiments.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { handleTeamMemory } from "#src/server/team-memory/http.server";

const url = Bun.env.TEAM_MEMORY_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "TEAM_MEMORY_TEST_DATABASE_URL must name a disposable migrated PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
let workspaceId: string, otherWorkspaceId: string, userId: string, agentId: string, peerId: string;
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: { username: `native-memory-${crypto.randomUUID()}`, displayName: "Memory owner" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `native-memory-${crypto.randomUUID()}`,
        name: "Team memory",
        experiments: { teamMemory: true },
        members: { create: { userId, role: "owner" } },
      },
    })
  ).id;
  otherWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `native-memory-other-${crypto.randomUUID()}`,
        name: "Other",
        experiments: { teamMemory: true },
        members: { create: { userId } },
      },
    })
  ).id;
  const make = (name: string) =>
    db.agent.create({
      data: {
        workspaceId,
        ownerId: userId,
        name,
        displayName: name,
        runtimeConfig: { provider: "pi" },
      },
    });
  agentId = (await make("developer")).id;
  peerId = (await make("reviewer")).id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (otherWorkspaceId) await db.workspace.delete({ where: { id: otherWorkspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
const actor = () => ({ workspaceId, agentId });
const service = () => teamMemory(db);
const draft = (title: string, content: string) => ({
  title,
  content,
  source: "User-confirmed result",
  applicability: "staging",
  kind: "fact" as const,
});
async function reviewed<T extends TeamMemoryWrite>(command: T, who = actor()) {
  const review = await service().execute(who, command);
  expect(review.status).toBe("review_required");
  expect(review.reviewToken).toBeString();
  return { ...command, reviewToken: review.reviewToken! };
}
async function write(command: TeamMemoryWrite, who = actor()) {
  return service().execute(who, await reviewed(command, who));
}
async function create(title: string, content: string) {
  return (
    await write({ operation: "create", ...draft(title, content), requestId: crypto.randomUUID() })
  ).entries[0]!;
}

test("team writes require review and share confirmed knowledge with another Agent", async () => {
  const command = {
    operation: "create" as const,
    ...draft("Preview domain", "coforgeusercontent.com 已购买，备案办理中"),
    requestId: crypto.randomUUID(),
  };
  const review = await service().execute(actor(), command);
  expect(review.status).toBe("review_required");
  expect(await db.teamMemoryEntry.count({ where: { workspaceId } })).toBe(0);
  const confirmed = { ...command, reviewToken: review.reviewToken! };
  const entry = (await service().execute(actor(), confirmed)).entries[0]!;
  expect(entry.authorAgentId).toBe(agentId);
  expect(
    (
      await service().execute(
        { workspaceId, agentId: peerId },
        { operation: "search", query: "域名 购买" },
      )
    ).entries[0]?.id,
  ).toBe(entry.id);
  expect((await service().execute(actor(), confirmed)).entries[0]?.id).toBe(entry.id);
  await expect(
    service().execute(
      { workspaceId: otherWorkspaceId, agentId },
      { operation: "get", id: entry.id },
    ),
  ).rejects.toThrow("memory_forbidden");
});

test("disabling workspace memory blocks every operation and re-enabling preserves knowledge", async () => {
  const settings = new Experiments(new PrismaExperimentsRepository(db), async () => false);
  const workspace = { workspaceId, workspaceSlug: "team-memory" };
  const entry = await create("Switch retention", "Retain confirmed knowledge");
  await expect(settings.set(workspace, "member", "teamMemory", false)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  const pending = await reviewed({
    operation: "update",
    ...draft(entry.title, "New knowledge"),
    id: entry.id,
    revision: entry.revision,
    reason: "Correction",
    requestId: crypto.randomUUID(),
  });
  const commands = [
    { operation: "search", query: "Switch retention" },
    { operation: "list" },
    { operation: "get", id: entry.id },
    { operation: "history", id: entry.id },
    { operation: "prepare", ...draft("Switch retention", "New knowledge") },
    { operation: "create", ...draft("Other", "Knowledge"), requestId: crypto.randomUUID() },
    pending,
  ] as const;
  await db.workspace.update({ where: { id: workspaceId }, data: { experiments: {} } });
  await expect(service().execute(actor(), { operation: "list" })).rejects.toThrow(
    "memory_disabled",
  );
  await settings.set(workspace, "owner", "teamMemory", false);
  try {
    for (const command of commands)
      await expect(service().execute(actor(), command)).rejects.toThrow("memory_disabled");
    const response = await handleTeamMemory(
      new Request("http://localhost/team-memory", {
        method: "POST",
        body: JSON.stringify({ operation: "list" }),
      }),
      actor(),
      service(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ errorCode: "memory_disabled" });
  } finally {
    await settings.set(workspace, "admin", "teamMemory", true);
  }
  expect(
    (await service().execute(actor(), { operation: "get", id: entry.id })).entries[0]?.content,
  ).toBe("Retain confirmed knowledge");
});

test("corrections preserve versions and concurrent reviewed writers cannot overwrite", async () => {
  const first = await create("Filing status", "pending");
  const base = {
    operation: "update" as const,
    ...draft("Filing status", "complete"),
    id: first.id,
    revision: first.revision,
    reason: "New verified confirmation",
    requestId: crypto.randomUUID(),
  };
  const a = await reviewed(base);
  const b = await reviewed({ ...base, requestId: crypto.randomUUID(), content: "different" });
  const results = await Promise.allSettled([
    service().execute(actor(), a),
    service().execute(actor(), b),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const history = await service().execute(actor(), { operation: "history", id: first.id });
  expect(history.entries.some((entry) => entry.content === "pending")).toBe(true);
  expect(history.entries[0]?.change?.reason).toBe("New verified confirmation");
});

test("history previews stay within a response budget and full versions are read explicitly", async () => {
  const original = "Original evidence ".padEnd(16_000, "界");
  const source = "原始证据".repeat(250);
  let entry = (
    await write({
      operation: "create",
      ...draft("Long evidence", original),
      source,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  for (let index = 0; index < 10; index++)
    entry = (
      await write({
        operation: "update",
        ...draft("Long evidence", `Revision ${index} `.padEnd(16_000, "界")),
        source,
        id: entry.id,
        revision: entry.revision,
        reason: "Verified correction".padEnd(1_000, "新"),
        requestId: crypto.randomUUID(),
      })
    ).entries[0]!;
  const seen: number[] = [];
  let offset = 0;
  while (true) {
    const result = await service().execute(actor(), { operation: "history", id: entry.id, offset });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12_000);
    expect(result.entries.every((item) => item.content.length <= 600)).toBe(true);
    seen.push(...result.entries.map((item) => item.revision));
    if (result.nextOffset === undefined) break;
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset;
  }
  expect(seen).toEqual(Array.from({ length: 11 }, (_, index) => 11 - index));
  const version = await service().execute(actor(), { operation: "get", id: entry.id, revision: 1 });
  expect(version.entries[0]?.content).toBe(original);
  expect(version.entries[0]?.source).toBe(source);
  expect(version.entries[0]?.change?.operation).toBe("create");
  await expect(
    service().execute(actor(), { operation: "get", id: entry.id, revision: 999 }),
  ).rejects.toThrow("memory_not_found");
});

test("merge is atomic and restore and permanent deletion affect current recall", async () => {
  const a = await create("Deploy checks", "Run tests"),
    b = await create("Build checks", "Run build");
  const merged = (
    await write({
      operation: "merge",
      ...draft("Deploy checks", "Run tests and build"),
      id: a.id,
      revision: a.revision,
      sources: [{ id: b.id, revision: b.revision }],
      requestId: crypto.randomUUID(),
      reason: "Complementary checks in the same environment",
    })
  ).entries[0]!;
  expect(
    (await service().execute(actor(), { operation: "get", id: b.id })).entries[0]?.status,
  ).toBe("archived");
  const archived = (await service().execute(actor(), { operation: "get", id: b.id })).entries[0]!;
  const archivedHistory = (await service().execute(actor(), { operation: "history", id: b.id }))
    .entries[0]!;
  expect(archivedHistory.updatedAt).toBe(archived.updatedAt);
  const restored = (
    await write({
      operation: "restore",
      id: a.id,
      revision: merged.revision,
      fromRevision: a.revision,
      requestId: crypto.randomUUID(),
      reason: "Undo erroneous merge",
    })
  ).entries[0]!;
  expect(restored.content).toBe("Run tests");
  const deletion = await reviewed({
    operation: "delete",
    id: a.id,
    revision: restored.revision,
    requestId: crypto.randomUUID(),
    reason: "Forget obsolete knowledge",
  });
  expect((await service().execute(actor(), deletion)).status).toBe("deleted");
  expect((await service().execute(actor(), deletion)).status).toBe("deleted");
  expect(await db.teamMemoryVersion.count({ where: { workspaceId, entryId: a.id } })).toBe(0);
  await expect(service().execute(actor(), { operation: "history", id: a.id })).rejects.toThrow(
    "memory_not_found",
  );
});

test("different workspaces and differing applicability cannot be combined", async () => {
  const entry = await create("Scope test", "Valid for staging");
  const outsider = await db.agent.create({
    data: {
      workspaceId: otherWorkspaceId,
      ownerId: userId,
      name: "outsider",
      displayName: "Other",
      runtimeConfig: {},
    },
  });
  await expect(
    service().execute(
      { workspaceId: otherWorkspaceId, agentId: outsider.id },
      { operation: "get", id: entry.id },
    ),
  ).rejects.toThrow("memory_not_found");
  const body = { ...draft("Scope test", "Valid for production"), applicability: "production" };
  const other = (await write({ operation: "create", ...body, requestId: crypto.randomUUID() }))
    .entries[0]!;
  await expect(
    write({
      operation: "merge",
      ...body,
      id: other.id,
      revision: other.revision,
      sources: [{ id: entry.id, revision: entry.revision }],
      reason: "Unsafe environment mix",
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_conflict");
  expect(
    (await service().execute(actor(), { operation: "get", id: entry.id })).entries[0]?.status,
  ).toBe("active");
});

test("agent administration authority controls destructive deletion independently of its owner", async () => {
  const entry = await create("Shared decision", "Retain unless explicitly removed");
  const remove = {
    operation: "delete" as const,
    id: entry.id,
    revision: entry.revision,
    reason: "Remove entry",
    requestId: crypto.randomUUID(),
  };
  const peer = { workspaceId, agentId: peerId };
  await expect(write(remove, peer)).rejects.toThrow("memory_forbidden");
  await db.agent.update({ where: { id: peerId }, data: { role: "admin" } });
  expect((await write(remove, peer)).status).toBe("deleted");
});

test("merging into an identical verified source preserves the destination identity", async () => {
  const target = await create("Initial answer", "Obsolete detail"),
    source = await create("Verified answer", "Use this exact verified answer");
  const saved = await write({
    operation: "merge",
    ...draft(source.title, source.content),
    id: target.id,
    revision: target.revision,
    sources: [{ id: source.id, revision: source.revision }],
    reason: "Superseded by verified source",
    requestId: crypto.randomUUID(),
  });
  expect(saved.entries[0]?.id).toBe(target.id);
  expect(saved.entries[0]?.content).toBe(source.content);
  expect(
    (await service().execute(actor(), { operation: "get", id: source.id })).entries[0]?.status,
  ).toBe("archived");
});

test("review tickets cannot be guessed, transferred, changed or used after expiry", async () => {
  const command = {
    operation: "create" as const,
    ...draft("Unreviewed", "Must inspect related entries"),
    requestId: crypto.randomUUID(),
  };
  await expect(
    service().execute(actor(), { ...command, reviewToken: crypto.randomUUID() }),
  ).rejects.toThrow("memory_conflict");
  const ticket = await reviewed(command);
  await expect(
    service().execute(actor(), { ...ticket, content: "Changed after review" }),
  ).rejects.toThrow("memory_conflict");
  await expect(service().execute({ workspaceId, agentId: peerId }, ticket)).rejects.toThrow(
    "memory_conflict",
  );
  await db.teamMemoryReceipt.update({
    where: { workspaceId_agentId_requestId: { workspaceId, agentId, requestId: ticket.requestId } },
    data: { reviewExpiresAt: new Date(0) },
  });
  await expect(service().execute(actor(), ticket)).rejects.toThrow("memory_conflict");
});

test("archiving frees the active dedup key without losing the archived entry", async () => {
  const first = await create("Archive test", "Retain history");
  await write({
    operation: "archive",
    id: first.id,
    revision: first.revision,
    reason: "Outdated",
    requestId: crypto.randomUUID(),
  });
  const second = await create("Archive test", "Retain history");
  expect(second.id).not.toBe(first.id);
  expect(
    (await service().execute(actor(), { operation: "get", id: first.id })).entries[0]?.status,
  ).toBe("archived");
});

test("revoked Agent access cannot read shared memory", async () => {
  await db.agent.update({ where: { id: peerId }, data: { deletedAt: new Date() } });
  await expect(
    service().execute({ workspaceId, agentId: peerId }, { operation: "search", query: "checks" }),
  ).rejects.toThrow("memory_forbidden");
});

test("retirement archives only registered legacy agents and retains their identity", async () => {
  const legacy = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: "legacy",
      displayName: "Memory",
      runtimeConfig: { runtime: "coforge" },
    },
  });
  await db.workspaceMemoryAgent.create({ data: { workspaceId, agentId: legacy.id } });
  const sql = await Bun.file(
    new URL(
      "../prisma/migrations/20261116120001_retire_dedicated_memory_agents/migration.sql",
      import.meta.url,
    ),
  ).text();
  const statement = sql.split(";\n").find((part) => part.trimStart().startsWith("UPDATE"));
  expect(statement).toBeDefined();
  await db.$executeRawUnsafe(statement!);
  const retired = await db.agent.findUniqueOrThrow({ where: { id: legacy.id } });
  expect(retired.displayName).toBe("Memory");
  expect(retired.deletedAt).not.toBeNull();
  expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).deletedAt).toBeNull();
});

test("an owner removed from the workspace removes its Agent memory access immediately", async () => {
  await db.workspaceMembership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
  try {
    await expect(service().execute(actor(), { operation: "list" })).rejects.toThrow(
      "memory_forbidden",
    );
  } finally {
    await db.workspaceMembership.create({ data: { workspaceId, userId, role: "owner" } });
  }
});
