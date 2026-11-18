import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import {
  listMemorySuggestions,
  reviewMemorySuggestion,
  submitMemorySuggestion,
} from "#src/server/team-memory/suggestion-review.server";
import { scanTeamMemorySuggestions } from "#src/server/team-memory/suggestion-scan.server";

const connectionString = Bun.env.TEAM_MEMORY_TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEAM_MEMORY_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `memory-review-${crypto.randomUUID()}`, displayName: "Memory reviewer" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `memory-review-${crypto.randomUUID()}`,
      name: "Memory review",
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

test("manual scanning proposes a duplicate and concurrent reviewers commit it once", async () => {
  const actor = { workspaceId, userId };
  const memory = teamMemory(db);
  for (const title of ["Deployment result", "Rollout outcome"]) {
    const draft = {
      operation: "create" as const,
      requestId: crypto.randomUUID(),
      title,
      content: "The smoke checks passed for version 42.",
      source: "Workspace acceptance",
      kind: "fact" as const,
      applicability: "production",
    };
    const review = await memory.execute(actor, draft);
    await memory.execute(actor, { ...draft, reviewToken: review.reviewToken });
  }
  const scan = await scanTeamMemorySuggestions(db, workspaceId, userId);
  expect(scan).toMatchObject({ inspected: 2, suggested: 1, scanId: expect.any(String) });
  expect(await scanTeamMemorySuggestions(db, workspaceId, userId)).toMatchObject({
    inspected: 2,
    suggested: 0,
  });
  const { rows } = await listMemorySuggestions(db, actor);
  expect(rows).toHaveLength(1);
  const id = rows[0]!.id;
  expect(rows[0]!.snapshots).toHaveLength(2);
  expect(rows[0]!.snapshots.every((version) => version.revision === 1)).toBe(true);
  expect(await reviewMemorySuggestion(db, actor, id, "verify")).toMatchObject({
    status: "verification",
  });
  expect((await listMemorySuggestions(db, actor)).rows[0]?.status).toBe("verification");
  const [first, second] = await Promise.all([
    reviewMemorySuggestion(db, actor, id, "accept"),
    reviewMemorySuggestion(db, actor, id, "accept"),
  ]);
  expect(first).toEqual(second);
  expect(first.status).toBe("accepted");
  expect(await db.teamMemorySuggestion.findUnique({ where: { id } })).toMatchObject({
    scanId: scan.scanId,
  });
  expect((await memory.execute(actor, { operation: "list" })).entries).toHaveLength(1);
  expect((await memory.execute(actor, { operation: "list", archived: true })).entries).toHaveLength(
    1,
  );
  expect((await listMemorySuggestions(db, actor)).rows).toHaveLength(0);
});

test("a scan discovers duplicates beyond the current cursor window", async () => {
  const workspace = await db.workspace.create({
    data: {
      slug: `memory-window-${crypto.randomUUID()}`,
      name: "Memory review window",
      members: { create: { userId, role: "owner" } },
    },
  });
  try {
    await db.teamMemoryEntry.createMany({
      data: Array.from({ length: 70 }, (_, index) => ({
        workspaceId: workspace.id,
        authorUserId: userId,
        title: `Decision ${index}`,
        content:
          index === 0 || index === 69 ? "Identical confirmed outcome" : `Unique evidence ${index}`,
        source: "Workspace acceptance",
        kind: "fact",
        applicability: "production",
        dedupKey: crypto.randomUUID(),
        searchText: `decision ${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    });
    const result = await scanTeamMemorySuggestions(db, workspace.id, userId);
    expect(result).toMatchObject({ inspected: 64, suggested: 1 });
    expect(
      (await listMemorySuggestions(db, { workspaceId: workspace.id, userId })).rows[0]?.kind,
    ).toBe("duplicate");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
  }
});

test("previously recorded review work does not hide a sixth unavailable source", async () => {
  const workspace = await db.workspace.create({
    data: {
      slug: `memory-evidence-limit-${crypto.randomUUID()}`,
      name: "Evidence review budget",
      members: { create: { userId, role: "owner" } },
    },
  });
  try {
    await db.teamMemoryEntry.createMany({
      data: Array.from({ length: 6 }, (_, index) => ({
        workspaceId: workspace.id,
        authorUserId: userId,
        title: `Evidence ${index}`,
        content: `Decision ${index}`,
        source: "Removed artifact",
        evidence: [{ kind: "artifact", id: crypto.randomUUID() }],
        kind: "decision",
        applicability: "production",
        dedupKey: crypto.randomUUID(),
        searchText: `evidence ${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    });
    expect((await scanTeamMemorySuggestions(db, workspace.id, userId)).suggested).toBe(5);
    expect((await scanTeamMemorySuggestions(db, workspace.id, userId)).suggested).toBe(1);
    expect((await scanTeamMemorySuggestions(db, workspace.id, userId)).suggested).toBe(0);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
  }
});

test("a correction shows the exact referenced revision and blocks withdrawn draft evidence", async () => {
  const actor = { workspaceId, userId };
  const memory = teamMemory(db);
  const raw = {
    operation: "create" as const,
    requestId: crypto.randomUUID(),
    title: "Recorded decision",
    content: "Old conclusion",
    source: "Confirmed in release review",
    applicability: "production",
    kind: "decision" as const,
  };
  const review = await memory.execute(actor, raw);
  const memoryHead = (await memory.execute(actor, { ...raw, reviewToken: review.reviewToken }))
    .entries[0]!;
  const correction = {
    ...raw,
    operation: "update" as const,
    requestId: crypto.randomUUID(),
    id: memoryHead.id,
    revision: memoryHead.revision,
    content: "New conclusion",
    reason: "Revised in release review",
  };
  await submitMemorySuggestion(db, actor, correction);
  const newer = {
    ...correction,
    requestId: crypto.randomUUID(),
    content: "Intermediate conclusion",
  };
  const confirmed = await memory.execute(actor, newer);
  await memory.execute(actor, { ...newer, reviewToken: confirmed.reviewToken });
  const listed = (await listMemorySuggestions(db, actor)).rows.find(
    ({ kind }) => kind === "draft",
  )!;
  expect(listed.snapshots[0]).toMatchObject({
    revision: memoryHead.revision,
    content: "Old conclusion",
  });
  expect(listed.payload).toMatchObject({ content: "New conclusion" });
  expect(await reviewMemorySuggestion(db, actor, listed.id, "accept")).toMatchObject({
    status: "stale",
  });

  const revoked = await db.teamMemorySuggestion.create({
    data: {
      workspaceId,
      kind: "draft",
      sourceKey: `draft:${crypto.randomUUID()}`,
      payload: { ...raw, evidence: [{ kind: "artifact", id: crypto.randomUUID() }] },
    },
  });
  const blocked = (await listMemorySuggestions(db, actor)).rows.find(({ id }) => id === revoked.id);
  expect(blocked).toMatchObject({ blocked: true, payload: { evidence: [] } });
  expect(await reviewMemorySuggestion(db, actor, revoked.id, "accept")).toMatchObject({
    status: "stale",
  });
});
