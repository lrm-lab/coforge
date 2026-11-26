import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { sweepExpiredDrafts } from "#src/server/artifacts/artifact-comment-draft-sweep.server";
import { submitDrafts } from "#src/server/artifacts/artifact-comment-drafts-submit.server";
import { ArtifactPageData } from "#src/server/artifacts/artifact-page-data.server";
import { PrismaTeamMemoryStore } from "#src/server/db/repositories/team-memory.repositories.server";
import { reviewMemorySuggestion } from "#src/server/team-memory/suggestion-review.server";

const WORKSPACE_ID = "0196ed00-0000-7000-8000-000000000001";
const AGENT_ID = "0196ed00-0000-7000-8000-000000000002";
const USER_ID = "0196ed00-0000-7000-8000-000000000003";
const ARTIFACT_ID = "0196ed00-0000-7000-8000-000000000004";
const ENTRY_ID = "0196ed00-0000-7000-8000-000000000005";
const SUGGESTION_ID = "0196ed00-0000-7000-8000-000000000006";

function sqlText(arg: unknown): string {
  if (Array.isArray(arg)) return arg.join(" ");
  if (arg && typeof arg === "object" && "strings" in arg && Array.isArray(arg.strings))
    return (arg.strings as string[]).join(" ");
  return String(arg ?? "");
}

test("PrismaTeamMemoryStore.write runs projectEvidence and maintenance pressure check after commit", async () => {
  let inTx = false;
  let maintenanceLookupsInTx = 0;
  let maintenanceLookupsAfterTx = 0;
  let evidenceLookupsInTx = 0;
  let evidenceLookupsAfterTx = 0;
  const now = new Date("2026-04-20T00:00:00Z");

  const entryRow = {
    id: ENTRY_ID,
    workspaceId: WORKSPACE_ID,
    projectId: null,
    pinned: false,
    title: "Deploy rule",
    content: "Always run migrations first",
    source: "retro",
    kind: "decision",
    applicability: "deploy",
    status: "active",
    revision: 2,
    authorAgentId: AGENT_ID,
    authorUserId: null,
    evidence: [{ kind: "task", id: "0196ed00-0000-7000-8000-000000000099", revision: 1 }],
    relations: null,
    effectiveAt: null,
    updatedAt: now,
  };

  const makeScope = () => ({
    teamMemoryState: {
      upsert: async () => ({ workspaceId: WORKSPACE_ID, revision: 1 }),
      update: async () => ({ workspaceId: WORKSPACE_ID, revision: 2 }),
    },
    teamMemoryReceipt: {
      findUnique: async () => ({
        fingerprint: "unused",
        reviewToken: "tok-1",
        reviewRevision: 1,
        reviewExpiresAt: new Date(Date.now() + 60_000),
        entryId: null,
        deleted: false,
      }),
      update: async () => ({}),
      upsert: async () => ({}),
    },
    teamMemoryEntry: {
      findFirst: async () => ({ ...entryRow, revision: 1 }),
      update: async () => entryRow,
    },
    teamMemoryVersion: {
      create: async () => ({}),
    },
    teamMemoryMaintenance: {
      findUnique: async () => {
        if (inTx) maintenanceLookupsInTx += 1;
        else maintenanceLookupsAfterTx += 1;
        return { suggestedAt: new Date() };
      },
    },
    task: {
      findMany: async () => {
        if (inTx) evidenceLookupsInTx += 1;
        else evidenceLookupsAfterTx += 1;
        return [{ id: "0196ed00-0000-7000-8000-000000000099", revision: 1 }];
      },
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("team_memory_states")) return [{ revision: 1 }];
      if (sql.includes("teamMemoryEnabled")) return [{ role: "member", teamMemoryEnabled: true }];
      return [];
    },
    $executeRaw: async () => 1,
  });

  const command = {
    operation: "update" as const,
    requestId: "req-1",
    reviewToken: "tok-1",
    id: ENTRY_ID,
    revision: 1,
    title: "Deploy rule",
    content: "Always run migrations first",
    source: "retro",
    kind: "decision" as const,
    applicability: "deploy",
    reason: "clarify",
  };
  const { fingerprint } =
    await import("#src/server/db/repositories/team-memory-projections.server");
  const expectedFingerprint = fingerprint(command);
  const scope = makeScope();
  scope.teamMemoryReceipt.findUnique = async () => ({
    fingerprint: expectedFingerprint,
    reviewToken: "tok-1",
    reviewRevision: 1,
    reviewExpiresAt: new Date(Date.now() + 60_000),
    entryId: null,
    deleted: false,
  });
  const db = {
    ...scope,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      inTx = true;
      try {
        return await fn(scope);
      } finally {
        inTx = false;
      }
    },
  };

  const store = new PrismaTeamMemoryStore(db as unknown as PrismaClient);
  const res = await store.write({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID }, command);
  expect(res.status).toBe("ok");
  expect(maintenanceLookupsInTx).toBe(0);
  expect(maintenanceLookupsAfterTx).toBe(1);
  expect(evidenceLookupsInTx).toBe(0);
  expect(evidenceLookupsAfterTx).toBe(1);
});

test("reviewMemorySuggestion accepts a draft suggestion without running the discarded ILIKE review scan", async () => {
  let reviewLikeQueries = 0;
  let receiptUpserts = 0;
  const now = new Date("2026-04-20T00:00:00Z");

  const draftPayload = {
    operation: "create",
    requestId: "orig-req",
    title: "Use bun",
    content: "Prefer Bun runtime",
    source: "team",
    kind: "decision",
    applicability: "runtime",
  };

  const tx = {
    teamMemorySuggestion: {
      findUnique: async () => ({
        id: SUGGESTION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "draft",
        status: "pending",
        payload: draftPayload,
        appliedEntryId: null,
        scanId: null,
      }),
      findUniqueOrThrow: async () => ({
        id: SUGGESTION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "draft",
        status: "pending",
        payload: draftPayload,
        appliedEntryId: null,
        scanId: null,
      }),
      update: async () => ({}),
    },
    teamMemoryState: {
      upsert: async () => ({ workspaceId: WORKSPACE_ID, revision: 1 }),
      update: async () => ({ workspaceId: WORKSPACE_ID, revision: 2 }),
    },
    teamMemoryUserReceipt: {
      findUnique: async () => null,
      upsert: async () => {
        receiptUpserts += 1;
        return {};
      },
      update: async () => {
        throw new Error("should upsert receipt when skipping review");
      },
    },
    teamMemoryEntry: {
      findUnique: async () => null,
      create: async () => ({
        id: ENTRY_ID,
        workspaceId: WORKSPACE_ID,
        projectId: null,
        pinned: false,
        title: "Use bun",
        content: "Prefer Bun runtime",
        source: "team",
        kind: "decision",
        applicability: "runtime",
        status: "active",
        revision: 1,
        authorAgentId: null,
        authorUserId: USER_ID,
        evidence: null,
        relations: null,
        effectiveAt: null,
        updatedAt: now,
      }),
    },
    teamMemoryVersion: {
      create: async () => ({}),
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("ILIKE")) reviewLikeQueries += 1;
      if (sql.includes("team_memory_suggestions")) return [{ id: SUGGESTION_ID }];
      if (sql.includes("team_memory_states")) return [{ revision: 1 }];
      return [{ role: "admin", enabled: true }];
    },
    $executeRaw: async () => 1,
  };
  const db = {
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };

  const res = await reviewMemorySuggestion(
    db as unknown as PrismaClient,
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    SUGGESTION_ID,
    "accept",
  );
  expect(res).toEqual({ status: "accepted", entryId: ENTRY_ID });
  expect(reviewLikeQueries).toBe(0);
  expect(receiptUpserts).toBe(1);
});

test("ArtifactPageData.write batches multi-doc writes into 1 pre-fetch and 1 delete + 1 upsert without per-row findUnique loops", async () => {
  let findUniqueCalls = 0;
  let batchReadCalls = 0;
  let batchDeleteCalls = 0;
  let batchUpsertCalls = 0;

  const tx = {
    artifactPageDocument: {
      findUnique: async () => {
        findUniqueCalls += 1;
        return null;
      },
      delete: async () => {
        throw new Error("expected batched delete");
      },
      upsert: async () => {
        throw new Error("expected batched upsert");
      },
      update: async () => {
        throw new Error("expected batched upsert");
      },
      aggregate: async () => ({ _count: { _all: 3 }, _sum: { sizeBytes: 120 } }),
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("artifact_page_documents") && sql.includes("unnest")) {
        batchReadCalls += 1;
        return [
          { collection: "items", docId: "a", data: { count: 1 }, version: 2 },
          { collection: "items", docId: "b", data: { old: true }, version: 3 },
          { collection: "items", docId: "c", data: { gone: true }, version: 1 },
        ];
      }
      return [];
    },
    $executeRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("DELETE FROM") && sql.includes("artifact_page_documents"))
        batchDeleteCalls += 1;
      if (
        sql.includes("INSERT INTO") &&
        sql.includes("artifact_page_documents") &&
        sql.includes("::timestamp(3)")
      )
        batchUpsertCalls += 1;
      return 1;
    },
  };
  const db = {
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };
  const reads = {
    artifact: async () => ({
      id: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
      homeKey: "channel:general",
      access: "home",
      entryPath: "index.html",
      canChange: true,
      authorAgentOwnerId: null,
    }),
  };

  const pageData = new ArtifactPageData(db as unknown as PrismaClient, reads as never);
  const results = await pageData.write({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    artifactId: ARTIFACT_ID,
    writes: [
      { op: "update", collection: "items", id: "a", ifVersion: 2, data: { extra: 2 } },
      { op: "delete", collection: "items", id: "b", ifVersion: 3 },
      { op: "delete", collection: "items", id: "c", ifVersion: 1 },
      { op: "set", collection: "items", id: "d", data: { fresh: true } },
      { op: "set", collection: "items", id: "temp", data: { x: 1 } },
      { op: "delete", collection: "items", id: "temp", ifVersion: 1 },
    ],
  });

  expect(results).toEqual([
    { collection: "items", id: "a", version: 3 },
    { collection: "items", id: "b", deleted: true },
    { collection: "items", id: "c", deleted: true },
    { collection: "items", id: "d", version: 1 },
    { collection: "items", id: "temp", version: 1 },
    { collection: "items", id: "temp", deleted: true },
  ]);
  expect(findUniqueCalls).toBe(0);
  expect(batchReadCalls).toBe(1);
  expect(batchDeleteCalls).toBe(1);
  expect(batchUpsertCalls).toBe(1);
});

test("sweepExpiredDrafts uses StoredArtifactBlobs.releaseMany once across multiple workspaces", async () => {
  let forUpdateQueries = 0;
  let releaseUpdates = 0;
  const workspaces = [
    "0196ed00-0000-7000-8000-000000000101",
    "0196ed00-0000-7000-8000-000000000102",
    "0196ed00-0000-7000-8000-000000000103",
  ];
  const tx = {
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("DELETE FROM") && sql.includes("artifact_comment_drafts")) {
        return workspaces.map((workspaceId, index) => ({
          workspaceId,
          images: [
            {
              sha256: `${"a".repeat(63)}${index}`,
              contentType: "image/png",
              sizeBytes: 100,
              width: 10,
              height: 10,
            },
          ],
        }));
      }
      if (sql.includes("FOR UPDATE") && sql.includes("artifact_blobs")) {
        forUpdateQueries += 1;
        return [];
      }
      return [];
    },
    $executeRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("UPDATE") && sql.includes("artifact_blobs")) releaseUpdates += 1;
      return 3;
    },
  };
  const db = {
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };
  const blobs = new StoredArtifactBlobs(db as unknown as PrismaClient, async () => {
    throw new Error("bucket unused");
  });

  const removed = await sweepExpiredDrafts(db as unknown as PrismaClient, blobs);
  expect(removed).toBe(3);
  expect(forUpdateQueries).toBe(1);
  expect(releaseUpdates).toBe(1);
});

test("submitDrafts resolves writerName before acquiring withCommentLock and never queries artifactCommentImage inside tx", async () => {
  let inTx = false;
  let userFindManyInTx = 0;
  let imageFindManyInTx = 0;
  const draftId = "0196ed00-0000-7000-8000-000000000701";
  const reviewId = "0196ed00-0000-7000-8000-000000000702";
  const commentId = "0196ed00-0000-7000-8000-000000000703";
  const now = new Date("2026-04-20T00:00:00Z");

  const draftRow = {
    id: draftId,
    version: 1,
    path: null,
    anchor: null,
    replyTo: null,
    body: "Looks good",
    images: [],
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };

  const scope = {
    artifactCommentReview: {
      findFirst: async () => null,
      create: async () => ({
        id: reviewId,
        version: 1,
        authorUserId: USER_ID,
        authorAgentId: null,
        body: null,
        createdAt: now,
      }),
    },
    artifactCommentDraft: {
      findMany: async () => [draftRow],
      deleteMany: async () => ({ count: 1 }),
    },
    artifactComment: {
      findFirst: async () => null,
      createManyAndReturn: async () => [
        {
          id: commentId,
          version: 1,
          path: null,
          anchor: null,
          rootId: null,
          reviewId,
          authorUserId: USER_ID,
          authorAgentId: null,
          body: "Looks good",
          createdAt: now,
          editedAt: null,
          deletedAt: null,
          resolvedAt: null,
          resolvedByUserId: null,
          resolvedByAgentId: null,
        },
      ],
    },
    artifactCommentRead: {
      upsert: async () => ({}),
    },
    artifactCommentImage: {
      findMany: async () => {
        if (inTx) imageFindManyInTx += 1;
        return [];
      },
    },
    artifactVersion: {
      findFirst: async () => ({ version: 1 }),
    },
    artifactFollow: {
      createMany: async () => ({ count: 1 }),
      findMany: async () => [],
    },
    artifactCommentMention: {
      createMany: async () => ({ count: 0 }),
    },
    artifact: {
      findUnique: async () => ({ authorAgentId: null }),
      findUniqueOrThrow: async () => ({ currentVersion: 1 }),
    },
    user: {
      findMany: async () => {
        if (inTx) userFindManyInTx += 1;
        return [{ id: USER_ID, displayName: "Alice" }];
      },
    },
    agent: {
      findMany: async () => [],
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("artifact_comment_drafts")) return [draftRow];
      if (sql.includes('AS "stamp"')) return [{ stamp: now }];
      return [];
    },
    $executeRaw: async () => 1,
  };
  const db = {
    ...scope,
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => {
      inTx = true;
      try {
        return await fn(scope);
      } finally {
        inTx = false;
      }
    },
  };

  const result = await submitDrafts(
    {
      db: db as unknown as PrismaClient,
      blobs: { use: async () => [], release: async () => {} } as never,
      port: {
        stage: async () => ({ deliveryId: "d1", push: async () => {} }),
        agents: async () => [],
      } as never,
    },
    {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      artifact: {
        id: ARTIFACT_ID,
        workspaceId: WORKSPACE_ID,
        title: "Spec",
        homeKey: "channel:general",
        conversationId: null,
        taskId: null,
        latestVersion: 1,
      } as never,
      draftIds: [draftId],
      clientKey: "ck-1",
    },
  );

  expect(result.status).toBe("sent");
  expect(userFindManyInTx).toBe(0);
  expect(imageFindManyInTx).toBe(0);
});

test("suggestTeamMemoryMaintenance uses atomic conditional upsert and returns undefined when claim loses race", async () => {
  const { suggestTeamMemoryMaintenance } =
    await import("#src/server/db/repositories/team-memory-maintenance.repositories.server");
  let claimed = true;
  let conditionalUpserts = 0;
  const db = {
    teamMemoryMaintenance: {
      findUnique: async () => null,
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("observedEntries")) {
        return [{ observedEntries: 65, observedBytes: 200_000 }];
      }
      if (sql.includes("INSERT INTO team_memory_maintenance") && sql.includes("ON CONFLICT")) {
        conditionalUpserts += 1;
        return claimed ? [{ workspaceId: WORKSPACE_ID }] : [];
      }
      return [];
    },
  };
  const entry = {
    id: ENTRY_ID,
    title: "t",
    content: "c",
    source: "s",
    kind: "decision" as const,
    applicability: "a",
    status: "active" as const,
    revision: 1,
    authorAgentId: AGENT_ID,
    projectId: null,
    pinned: false,
    updatedAt: new Date().toISOString(),
  };

  const won = await suggestTeamMemoryMaintenance(
    db as unknown as PrismaClient,
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
    entry,
    "0196ed00-0000-7000-8000-000000000801",
  );
  expect(won?.observedEntries).toBe(65);

  claimed = false;
  const lost = await suggestTeamMemoryMaintenance(
    db as unknown as PrismaClient,
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
    entry,
    "0196ed00-0000-7000-8000-000000000802",
  );
  expect(lost).toBeUndefined();
  expect(conditionalUpserts).toBe(2);
});
