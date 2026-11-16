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
        const results: PageWriteResult[] = [];
        for (const write of checked) results.push(await applyWrite(tx, input, write));
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

async function applyWrite(
  tx: Prisma.TransactionClient,
  input: PageViewerInput,
  write: Checked,
): Promise<PageWriteResult> {
  const key = {
    artifactId_collection_docId: {
      artifactId: input.artifactId,
      collection: write.collection,
      docId: write.id,
    },
  };
  const existing = await tx.artifactPageDocument.findUnique({
    where: key,
    select: { data: true, version: true },
  });
  if (write.ifVersion !== undefined && (existing?.version ?? 0) !== write.ifVersion)
    return conflict("artifact-data-version");
  const { collection, id } = write;
  if (write.op === "delete") {
    if (!existing) return { collection, id, deleted: false };
    await tx.artifactPageDocument.delete({ where: key });
    return { collection, id, deleted: true };
  }
  const writer = { userId: input.userId, agentId: null };
  if (write.op === "set") {
    const { data, sizeBytes } = write as Required<Pick<Checked, "data" | "sizeBytes">>;
    const row = await tx.artifactPageDocument.upsert({
      where: key,
      create: {
        artifactId: input.artifactId,
        collection,
        docId: id,
        data: data as Prisma.InputJsonObject,
        sizeBytes,
        ...writer,
      },
      update: {
        data: data as Prisma.InputJsonObject,
        sizeBytes,
        version: { increment: 1 },
        ...writer,
      },
      select: { version: true },
    });
    return { collection, id, version: row.version };
  }
  if (!existing) throw new AppError("NOT_FOUND", { errorId: "artifact-data-missing" });
  const merged = pageDocumentData({
    ...(existing.data as Record<string, unknown>),
    ...write.data,
  });
  const row = await tx.artifactPageDocument.update({
    where: key,
    data: {
      data: merged.data as Prisma.InputJsonObject,
      sizeBytes: merged.sizeBytes,
      version: { increment: 1 },
      ...writer,
    },
    select: { version: true },
  });
  return { collection, id, version: row.version };
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
