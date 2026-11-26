import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { pageAccess, type PageReads, type PageViewerInput } from "./artifact-page-access.server";
import { PAGE_BATCH_MAX } from "#src/features/artifacts/artifact-page-limits";
import {
  PAGE_DATA_MAX_BYTES,
  PAGE_DATA_MAX_DOCUMENTS,
  pageCollection,
  pageDocId,
  pageDocumentData,
  pageIfVersion,
} from "./artifact-page-data-rules.server";
import {
  pageQuery,
  queryPageDocuments,
  viewOf,
  type PageDocumentView,
  type PageQueryResult,
} from "./artifact-page-data-query.server";
import { announceDataChange, type ArtifactSignals } from "./artifact-signals.server";

export type PageWrite =
  | { op: "set"; collection: string; id: string; data?: unknown; ifVersion?: number }
  | { op: "update"; collection: string; id: string; data?: unknown; ifVersion?: number }
  | { op: "delete"; collection: string; id: string; ifVersion?: number };

export type PageWriteResult =
  | { collection: string; id: string; version: number }
  | { collection: string; id: string; deleted: boolean };

const WRITE_TIMEOUT_MS = 15_000;

const conflict = (errorId: string): never => {
  throw new AppError("CONFLICT", { errorId });
};

type Checked = {
  op: PageWrite["op"];
  collection: string;
  id: string;
  ifVersion?: number;
  data?: Record<string, unknown>;
  sizeBytes?: number;
};

function checkWrite(write: PageWrite): Checked {
  const base = {
    op: write.op,
    collection: pageCollection(write.collection),
    id: pageDocId(write.id),
    ifVersion: pageIfVersion(write.ifVersion),
  };
  if (write.op === "delete") return base;
  return { ...base, ...pageDocumentData(write.data) };
}

export class ArtifactPageData {
  constructor(
    private readonly db: PrismaClient,
    private readonly reads: PageReads,
    private readonly signals?: ArtifactSignals,
  ) {}

  async get(
    input: PageViewerInput & { collection: unknown; id: unknown },
  ): Promise<PageDocumentView | null> {
    await pageAccess(this.reads, input, "view");
    const row = await this.db.artifactPageDocument.findUnique({
      where: {
        artifactId_collection_docId: {
          artifactId: input.artifactId,
          collection: pageCollection(input.collection),
          docId: pageDocId(input.id),
        },
      },
      select: { collection: true, docId: true, data: true, version: true, updatedAt: true },
    });
    return row && viewOf(row);
  }

  async query(
    input: PageViewerInput & { collection: unknown; query?: unknown },
  ): Promise<PageQueryResult> {
    await pageAccess(this.reads, input, "view");
    return queryPageDocuments(
      this.db,
      input.artifactId,
      pageCollection(input.collection),
      pageQuery(input.query),
    );
  }

  async write(
    input: PageViewerInput & { writes: readonly PageWrite[] },
  ): Promise<PageWriteResult[]> {
    if (input.writes.length === 0 || input.writes.length > PAGE_BATCH_MAX)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-data-batch" });
    const checked = input.writes.map(checkWrite);
    const access = await pageAccess(this.reads, input, "interact");
    const results = await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-page-data:${input.artifactId}`}, 0))`;
        const results = await applyBatch(tx, input, checked);
        if (checked.some((write) => write.op !== "delete")) await requireWithinCaps(tx, input);
        return results;
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
    const collections = new Set(checked.map((write) => write.collection));
    for (const collection of collections)
      await announceDataChange(this.signals, {
        workspaceId: input.workspaceId,
        homeKey: access.homeKey,
        artifactId: input.artifactId,
        collection,
      });
    return results;
  }
}

type DocState = {
  collection: string;
  docId: string;
  existedInDb: boolean;
  present: boolean;
  data: Record<string, unknown>;
  version: number;
  sizeBytes: number;
  dirty?: "upsert" | "delete";
};

function stateKey(collection: string, docId: string): string {
  return `${collection.length}:${collection}:${docId}`;
}

async function loadExistingDocs(
  tx: Prisma.TransactionClient,
  artifactId: string,
  uniqueKeys: readonly { collection: string; docId: string }[],
): Promise<Map<string, { data: Record<string, unknown>; version: number }>> {
  const byKey = new Map<string, { data: Record<string, unknown>; version: number }>();
  if (uniqueKeys.length === 1) {
    const only = uniqueKeys[0]!;
    const row = await tx.artifactPageDocument.findUnique({
      where: {
        artifactId_collection_docId: {
          artifactId,
          collection: only.collection,
          docId: only.docId,
        },
      },
      select: { data: true, version: true },
    });
    if (row) {
      byKey.set(stateKey(only.collection, only.docId), {
        data: row.data as Record<string, unknown>,
        version: row.version,
      });
    }
    return byKey;
  }
  const rows = await tx.$queryRaw<
    Array<{ collection: string; docId: string; data: unknown; version: number }>
  >`
    SELECT d."collection", d."docId", d."data", d."version"
    FROM "artifact_page_documents" d
    JOIN unnest(
      ${uniqueKeys.map((entry) => entry.collection)}::text[],
      ${uniqueKeys.map((entry) => entry.docId)}::text[]
    ) AS v("collection", "docId")
      ON d."collection" = v."collection" AND d."docId" = v."docId"
    WHERE d."artifactId" = ${artifactId}::uuid`;
  for (const row of rows) {
    byKey.set(stateKey(row.collection, row.docId), {
      data: row.data as Record<string, unknown>,
      version: row.version,
    });
  }
  return byKey;
}

async function applyBatch(
  tx: Prisma.TransactionClient,
  input: PageViewerInput,
  checked: readonly Checked[],
): Promise<PageWriteResult[]> {
  const uniqueMap = new Map<string, { collection: string; docId: string }>();
  for (const write of checked) {
    const key = stateKey(write.collection, write.id);
    if (!uniqueMap.has(key)) uniqueMap.set(key, { collection: write.collection, docId: write.id });
  }
  const uniqueKeys = [...uniqueMap.values()].sort(
    (a, b) => a.collection.localeCompare(b.collection) || a.docId.localeCompare(b.docId),
  );
  const existing = await loadExistingDocs(tx, input.artifactId, uniqueKeys);
  const states = new Map<string, DocState>();
  for (const { collection, docId } of uniqueKeys) {
    const key = stateKey(collection, docId);
    const found = existing.get(key);
    states.set(key, {
      collection,
      docId,
      existedInDb: Boolean(found),
      present: Boolean(found),
      data: found?.data ?? {},
      version: found?.version ?? 0,
      sizeBytes: 0,
    });
  }

  const results: PageWriteResult[] = [];
  for (const write of checked) {
    const state = states.get(stateKey(write.collection, write.id))!;
    if (write.ifVersion !== undefined && (state.present ? state.version : 0) !== write.ifVersion)
      return conflict("artifact-data-version");
    const { collection, id } = write;
    if (write.op === "delete") {
      if (!state.present) {
        results.push({ collection, id, deleted: false });
        continue;
      }
      state.present = false;
      state.version = 0;
      state.dirty = state.existedInDb ? "delete" : undefined;
      results.push({ collection, id, deleted: true });
      continue;
    }
    if (write.op === "set") {
      const { data, sizeBytes } = write as Required<Pick<Checked, "data" | "sizeBytes">>;
      state.version = state.present ? state.version + 1 : 1;
      state.present = true;
      state.data = data;
      state.sizeBytes = sizeBytes;
      state.dirty = "upsert";
      results.push({ collection, id, version: state.version });
      continue;
    }
    if (!state.present) throw new AppError("NOT_FOUND", { errorId: "artifact-data-missing" });
    const merged = pageDocumentData({ ...state.data, ...write.data });
    state.data = merged.data;
    state.sizeBytes = merged.sizeBytes;
    state.version += 1;
    state.dirty = "upsert";
    results.push({ collection, id, version: state.version });
  }

  const toDelete: DocState[] = [];
  const toUpsert: DocState[] = [];
  for (const state of states.values()) {
    if (state.dirty === "delete") toDelete.push(state);
    else if (state.dirty === "upsert") toUpsert.push(state);
  }

  if (toDelete.length === 1) {
    const only = toDelete[0]!;
    await tx.artifactPageDocument.delete({
      where: {
        artifactId_collection_docId: {
          artifactId: input.artifactId,
          collection: only.collection,
          docId: only.docId,
        },
      },
    });
  } else if (toDelete.length > 1) {
    await tx.$executeRaw`DELETE FROM "artifact_page_documents" AS d
      USING unnest(
        ${toDelete.map((entry) => entry.collection)}::text[],
        ${toDelete.map((entry) => entry.docId)}::text[]
      ) AS v("collection", "docId")
      WHERE d."artifactId" = ${input.artifactId}::uuid
        AND d."collection" = v."collection"
        AND d."docId" = v."docId"`;
  }

  if (toUpsert.length === 1) {
    const only = toUpsert[0]!;
    const writer = { userId: input.userId, agentId: null };
    await tx.artifactPageDocument.upsert({
      where: {
        artifactId_collection_docId: {
          artifactId: input.artifactId,
          collection: only.collection,
          docId: only.docId,
        },
      },
      create: {
        artifactId: input.artifactId,
        collection: only.collection,
        docId: only.docId,
        data: only.data as Prisma.InputJsonObject,
        sizeBytes: only.sizeBytes,
        version: only.version,
        ...writer,
      },
      update: {
        data: only.data as Prisma.InputJsonObject,
        sizeBytes: only.sizeBytes,
        version: only.version,
        ...writer,
      },
      select: { version: true },
    });
  } else if (toUpsert.length > 1) {
    const now = new Date();
    await tx.$executeRaw`INSERT INTO "artifact_page_documents"
      ("id", "artifactId", "collection", "docId", "data", "version", "sizeBytes", "userId", "agentId", "createdAt", "updatedAt")
      SELECT v."id", ${input.artifactId}::uuid, v."collection", v."docId", v."data", v."version", v."sizeBytes", ${input.userId}::uuid, NULL::uuid, ${now}::timestamp(3), ${now}::timestamp(3)
      FROM unnest(
        ${toUpsert.map(() => Bun.randomUUIDv7())}::uuid[],
        ${toUpsert.map((entry) => entry.collection)}::text[],
        ${toUpsert.map((entry) => entry.docId)}::text[],
        ${toUpsert.map((entry) => JSON.stringify(entry.data))}::jsonb[],
        ${toUpsert.map((entry) => entry.version)}::int[],
        ${toUpsert.map((entry) => entry.sizeBytes)}::int[]
      ) AS v("id", "collection", "docId", "data", "version", "sizeBytes")
      ON CONFLICT ("artifactId", "collection", "docId") DO UPDATE SET
        "data" = EXCLUDED."data",
        "version" = EXCLUDED."version",
        "sizeBytes" = EXCLUDED."sizeBytes",
        "userId" = EXCLUDED."userId",
        "agentId" = EXCLUDED."agentId",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }

  return results;
}

async function requireWithinCaps(tx: Prisma.TransactionClient, input: PageViewerInput) {
  const total = await tx.artifactPageDocument.aggregate({
    where: { artifactId: input.artifactId },
    _sum: { sizeBytes: true },
    _count: { _all: true },
  });
  if (
    total._count._all > PAGE_DATA_MAX_DOCUMENTS ||
    (total._sum.sizeBytes ?? 0) > PAGE_DATA_MAX_BYTES
  )
    throw new AppError("INVALID_INPUT", { errorId: "artifact-data-full" });
}
