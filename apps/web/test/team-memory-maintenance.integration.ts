import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import { decodeTeamMemoryResult, type TeamMemoryWrite } from "@lrm/coforge-sdk/agent";
const url = Bun.env.TEAM_MEMORY_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "TEAM_MEMORY_TEST_DATABASE_URL must name a disposable migrated PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
let workspaceId: string, userId: string, agentId: string, peerId: string;
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: { username: `maintenance-${crypto.randomUUID()}`, displayName: "Memory owner" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `maintenance-${crypto.randomUUID()}`,
        name: "Maintenance",
        members: { create: { userId, role: "owner" } },
      },
    })
  ).id;
  const create = (name: string) =>
    db.agent.create({
      data: {
        workspaceId,
        ownerId: userId,
        name,
        displayName: name,
        runtimeConfig: { provider: "pi" },
      },
    });
  agentId = (await create("writer")).id;
  peerId = (await create("peer")).id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
const actor = () => ({ workspaceId, agentId });
const service = () => teamMemory(db);
const draft = (title: string) => ({
  title,
  content: `Confirmed ${title}`,
  source: "User confirmation",
  kind: "fact" as const,
  applicability: "staging",
});
async function write(command: TeamMemoryWrite) {
  const review = await service().execute(actor(), command);
  return service().execute(actor(), { ...command, reviewToken: review.reviewToken! });
}

test("small libraries inject no maintenance hint; pressure goes only to the successful writer", async () => {
  const small = await write({
    operation: "create",
    ...draft("Small library"),
    requestId: crypto.randomUUID(),
  });
  expect(small.maintenanceHint).toBeUndefined();
  await db.teamMemoryEntry.createMany({
    data: Array.from({ length: 64 }, (_, i) => ({
      ...draft(`Existing ${i}`),
      workspaceId,
      authorAgentId: agentId,
      dedupKey: `seed-${i}`,
      searchText: `Existing ${i}`,
    })),
  });
  const command = {
    operation: "create" as const,
    ...draft("Threshold write"),
    requestId: crypto.randomUUID(),
  };
  const result = await write(command);
  expect(result.maintenanceHint?.projectId).toBeNull();
  expect(result.maintenanceHint?.observedEntries).toBeGreaterThanOrEqual(64);
  const second = await write({
    operation: "create",
    ...draft("Another write"),
    requestId: crypto.randomUUID(),
  });
  expect(second.maintenanceHint).toBeUndefined();
  await expect(
    service().execute({ workspaceId, agentId: peerId }, { operation: "maintenance" }),
  ).rejects.toThrow("memory_forbidden");
  const batch = await service().execute(actor(), { operation: "maintenance" });
  expect(batch.entries.length).toBeLessThanOrEqual(5);
  expect(batch.maintenance?.remaining).toBe(5);
  expect(batch.maintenance?.token).toBeString();
  const repeated = await service().execute(actor(), { operation: "maintenance" });
  expect(repeated.maintenance?.token).toBe(batch.maintenance?.token);
  expect(repeated.maintenance?.expiresAt).toBe(batch.maintenance?.expiresAt);
  const target = batch.entries[0]!;
  const corrected = await write({
    operation: "update",
    ...draft(target.title),
    content: "Verified shorter conclusion",
    id: target.id,
    revision: target.revision,
    reason: "Keep evidence",
    requestId: crypto.randomUUID(),
    maintenanceToken: batch.maintenance!.token,
  });
  expect(corrected.entries[0]?.content).toBe("Verified shorter conclusion");
  expect(
    (await service().execute(actor(), { operation: "maintenance" })).maintenance?.remaining,
  ).toBe(4);
  await expect(
    write({
      operation: "delete",
      id: target.id,
      revision: corrected.entries[0]!.revision,
      reason: "Must not delete",
      requestId: crypto.randomUUID(),
      maintenanceToken: batch.maintenance!.token,
    }),
  ).rejects.toThrow("memory_forbidden");
  await db.teamMemoryMaintenance.update({
    where: { workspaceId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await expect(
    write({
      operation: "archive",
      id: target.id,
      revision: corrected.entries[0]!.revision,
      reason: "Expired batch",
      requestId: crypto.randomUUID(),
      maintenanceToken: batch.maintenance!.token,
    }),
  ).rejects.toThrow("memory_conflict");
  expect(
    (await service().execute(actor(), { operation: "get", id: target.id })).entries[0]?.status,
  ).toBe("active");
});

async function startBatch(title: string) {
  await db.teamMemoryMaintenance.deleteMany({ where: { workspaceId } });
  const result = await write({
    operation: "create",
    ...draft(title),
    requestId: crypto.randomUUID(),
  });
  expect(result.maintenanceHint).toBeDefined();
  return service().execute(actor(), { operation: "maintenance" });
}

test("automatic maintenance cannot unpin, change Projects, create or restore entries", async () => {
  const protectedEntry = (
    await write({
      operation: "create",
      ...draft("Protected decision"),
      pinned: true,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  const batch = await startBatch("Protection threshold");
  const token = batch.maintenance!.token;
  expect(batch.entries.some((entry) => entry.id === protectedEntry.id)).toBe(false);
  await expect(
    write({
      operation: "update",
      ...draft(protectedEntry.title),
      pinned: false,
      id: protectedEntry.id,
      revision: protectedEntry.revision,
      reason: "Bypass protection",
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  const project = await db.project.create({
    data: { workspaceId, name: "Separate project", slug: `separate-${crypto.randomUUID()}` },
  });
  const other = (
    await write({
      operation: "create",
      ...draft("Project scope"),
      projectId: project.id,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  await expect(
    write({
      operation: "archive",
      id: other.id,
      revision: other.revision,
      reason: "Wrong project",
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  await expect(
    write({
      operation: "create",
      ...draft("No automatic new facts"),
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  await write({
    operation: "create",
    ...draft("No automatic new facts"),
    requestId: crypto.randomUUID(),
  });
  await expect(
    write({
      operation: "create",
      ...draft("No automatic new facts"),
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  const target = batch.entries[0]!;
  await expect(
    write({
      operation: "restore",
      id: target.id,
      revision: target.revision,
      fromRevision: 1,
      reason: "No automatic restore",
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  expect((await db.teamMemoryMaintenance.findUnique({ where: { workspaceId } }))?.remaining).toBe(
    5,
  );
});

test("merge sources count against the five-entry budget and failed operations consume nothing", async () => {
  const batch = await startBatch("Budget threshold");
  const token = batch.maintenance!.token;
  const [target, one, two, three, four] = batch.entries;
  expect(batch.entries).toHaveLength(5);
  const merged = (
    await write({
      operation: "merge",
      ...draft("Verified consolidated fact"),
      content: "Combined verified conclusions",
      id: target!.id,
      revision: target!.revision,
      sources: [
        { id: one!.id, revision: one!.revision },
        { id: two!.id, revision: two!.revision },
      ],
      reason: "Evidence checked",
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  expect((await db.teamMemoryMaintenance.findUnique({ where: { workspaceId } }))?.remaining).toBe(
    2,
  );
  await expect(
    write({
      operation: "merge",
      ...draft("Larger batch"),
      id: merged.id,
      revision: merged.revision,
      sources: [
        { id: three!.id, revision: three!.revision },
        { id: four!.id, revision: four!.revision },
      ],
      reason: "Would exceed budget",
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_conflict");
  expect((await db.teamMemoryEntry.findUnique({ where: { id: three!.id } }))?.status).toBe(
    "active",
  );
  expect((await db.teamMemoryMaintenance.findUnique({ where: { workspaceId } }))?.remaining).toBe(
    2,
  );
  const command = {
    operation: "archive" as const,
    id: three!.id,
    revision: three!.revision,
    reason: "Verified obsolete",
    maintenanceToken: token,
    requestId: crypto.randomUUID(),
  };
  const review = await service().execute(actor(), command);
  const confirmed = { ...command, reviewToken: review.reviewToken! };
  await service().execute(actor(), confirmed);
  await service().execute(actor(), confirmed);
  expect((await db.teamMemoryMaintenance.findUnique({ where: { workspaceId } }))?.remaining).toBe(
    1,
  );
  await write({
    operation: "archive",
    id: four!.id,
    revision: four!.revision,
    reason: "Verified obsolete",
    maintenanceToken: token,
    requestId: crypto.randomUUID(),
  });
  expect(
    (await service().execute(actor(), { operation: "maintenance" })).maintenance?.remaining,
  ).toBe(0);
  await expect(
    write({
      operation: "archive",
      id: merged.id,
      revision: merged.revision,
      reason: "No allowance left",
      maintenanceToken: token,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_conflict");
});

test("Workspace disabling blocks maintenance and human writes never ask an Agent to tidy", async () => {
  const batch = await startBatch("Disabled threshold");
  await db.workspace.update({
    where: { id: workspaceId },
    data: { experiments: { teamMemory: false } },
  });
  try {
    await expect(service().execute(actor(), { operation: "maintenance" })).rejects.toThrow(
      "memory_disabled",
    );
    const target = batch.entries[0]!;
    await expect(
      write({
        operation: "archive",
        id: target.id,
        revision: target.revision,
        reason: "Disabled",
        maintenanceToken: batch.maintenance!.token,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("memory_disabled");
  } finally {
    await db.workspace.update({
      where: { id: workspaceId },
      data: { experiments: { teamMemory: true } },
    });
  }
  await db.teamMemoryMaintenance.deleteMany({ where: { workspaceId } });
  const human = { workspaceId, userId };
  const command = {
    operation: "create" as const,
    ...draft("Human maintenance boundary"),
    requestId: crypto.randomUUID(),
  };
  const review = await service().execute(human, command);
  const result = await service().execute(human, { ...command, reviewToken: review.reviewToken! });
  expect(result.maintenanceHint).toBeUndefined();
  await expect(service().execute(human, { operation: "maintenance" })).rejects.toThrow(
    "memory_forbidden",
  );
});

test("an indented memory has a readable candidate preview", async () => {
  const padded = (
    await write({
      operation: "create",
      ...draft("Indented memory"),
      content: `${" ".repeat(600)}Verified paragraph`,
      source: `${" ".repeat(200)}Verified source`,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  await db.teamMemoryEntry.update({
    where: { id: padded.id },
    data: { updatedAt: new Date(0) },
  });
  const batch = decodeTeamMemoryResult(await startBatch("Readable candidate threshold"));
  expect(batch.entries[0]).toMatchObject({
    id: padded.id,
    content: "Verified paragraph",
    source: "Verified source",
  });
});

test("the triggering write can recover its unclaimed hint after a lost response", async () => {
  await db.teamMemoryMaintenance.deleteMany({ where: { workspaceId } });
  const command = {
    operation: "create" as const,
    ...draft("Recoverable maintenance hint"),
    requestId: crypto.randomUUID(),
  };
  const review = await service().execute(actor(), command);
  const confirmed = { ...command, reviewToken: review.reviewToken! };
  const first = await service().execute(actor(), confirmed);
  expect(first.maintenanceHint).toBeDefined();

  const other = {
    operation: "create" as const,
    ...draft("Unrelated later write"),
    requestId: crypto.randomUUID(),
  };
  expect((await write(other)).maintenanceHint).toBeUndefined();
  expect((await service().execute(actor(), other)).maintenanceHint).toBeUndefined();
  const retry = await service().execute(actor(), confirmed);
  expect(retry.replayed).toBe(true);
  expect(retry.maintenanceHint).toMatchObject({
    projectId: null,
    nextCommand: first.maintenanceHint!.nextCommand,
  });
  expect((await service().execute(actor(), command)).maintenanceHint).toBeDefined();

  const batch = await service().execute(actor(), { operation: "maintenance" });
  expect(batch.maintenance?.token).not.toBe(confirmed.requestId);
  expect((await service().execute(actor(), confirmed)).maintenanceHint).toBeUndefined();
});
