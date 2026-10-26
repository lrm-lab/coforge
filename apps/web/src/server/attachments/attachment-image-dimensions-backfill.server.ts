import type { PrismaClient } from "#src/generated/prisma/client";
import { getFileStorage, type FileStorage } from "#src/server/files/file-storage.server";
import {
  countAttachmentDimensionBackfillCandidates,
  listAttachmentDimensionBackfillCandidates,
  setAttachmentDimensionsIfUnknown,
  type BackfillCursor,
} from "#src/server/db/repositories/attachment-image-dimensions-backfill.repositories.server";
import {
  readStoredImageDimensionsResult,
  type StoredImageDimensionsResult,
} from "./attachment-image-dimensions.server";

export type BackfillOptions = {
  cutoff: Date;
  maxItems: number;
  batchSize: number;
  batchDelayMs: number;
  dryRun: boolean;
  after?: BackfillCursor;
  db: PrismaClient;
  storage?: Pick<FileStorage, "readPrefix">;
  onBatch?: (checkpoint: { after: BackfillCursor; processed: number }) => void | Promise<void>;
};
export type BackfillSummary = {
  mode: "dry-run" | "apply";
  candidates: number;
  successes: number;
  unknown: number;
  failed: number;
  failedReasons: Record<string, number>;
  processed: number;
  lastCursor: BackfillCursor;
};

const pause = (milliseconds: number) =>
  milliseconds > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

export async function backfillAttachmentImageDimensions(
  options: BackfillOptions,
): Promise<BackfillSummary> {
  if (
    !Number.isInteger(options.maxItems) ||
    options.maxItems < 0 ||
    !Number.isInteger(options.batchSize) ||
    options.batchSize <= 0 ||
    !Number.isInteger(options.batchDelayMs) ||
    options.batchDelayMs < 0
  )
    throw new Error("invalid backfill limits");
  const plan = await countAttachmentDimensionBackfillCandidates(options.db, options.cutoff);
  if (options.maxItems < plan.images)
    throw new Error(`max-items ${options.maxItems} is below candidate count ${plan.images}`);
  const summary: BackfillSummary = {
    mode: options.dryRun ? "dry-run" : "apply",
    candidates: plan.images,
    successes: 0,
    unknown: 0,
    failed: 0,
    failedReasons: {},
    processed: 0,
    lastCursor: options.after ?? null,
  };
  const storage = options.storage ?? (await getFileStorage());
  let after = options.after ?? null;
  while (summary.processed < plan.images) {
    const rows = await listAttachmentDimensionBackfillCandidates(options.db, {
      cutoff: options.cutoff,
      after,
      limit: Math.min(options.batchSize, plan.images - summary.processed),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const result: StoredImageDimensionsResult = await readStoredImageDimensionsResult(
        storage,
        row,
      );
      if (result.status === "known") {
        if (
          options.dryRun ||
          (await setAttachmentDimensionsIfUnknown(options.db, { id: row.id, ...result.dimensions }))
        )
          summary.successes++;
        else {
          summary.failed++;
          bump(summary.failedReasons, "concurrent_change");
        }
      } else if (result.status === "unknown") summary.unknown++;
      else {
        summary.failed++;
        bump(summary.failedReasons, result.reason);
      }
      summary.processed++;
      after = { createdAt: row.createdAt, id: row.id };
      summary.lastCursor = after;
    }
    await options.onBatch?.({ after, processed: summary.processed });
    if (summary.processed < plan.images) await pause(options.batchDelayMs);
  }
  return summary;
}
