import type { PrismaClient } from "#src/generated/prisma/client";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { BulkFileRemoval } from "#src/server/files/file-storage.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/**
 * Daily cleanup for uploads that never reached a sent message (task #627): an `Attachment`
 * row lands with `messageId` null and only a send claims it, so rows older than the retention
 * window are composer drafts and abandoned agent uploads nobody can read. Rows are deleted
 * under a `messageId IS NULL` fence so a send that claimed one after the candidate read keeps
 * it; the storage objects go only after the row delete commits, best effort — a leftover
 * object is unreferenced storage waste, never a broken attachment.
 */

/** How long an unclaimed upload may sit before the sweep removes it (task #627: seven days). */
export const ORPHAN_ATTACHMENT_RETENTION_MS = 7 * 86_400_000;
/** A `verifying` session untouched this long is counted as a zombie (task #627: one hour). */
export const UPLOAD_SESSION_ZOMBIE_MS = 60 * 60 * 1_000;
/** The sweep's period: once a day, on every instance. */
export const ATTACHMENT_ORPHAN_SWEEP_MS = 24 * 60 * 60 * 1_000;
/** Candidates one statement handles, so no delete holds a long lock. */
const SWEEP_BATCH = 200;
/** Statements one run makes at most; the rest waits for the next day. */
const SWEEP_MAX_BATCHES = 50;

/** The oldest `createdAt` an unclaimed attachment may have at `now`. */
export function orphanAttachmentCutoff(now: Date): Date {
  return new Date(now.getTime() - ORPHAN_ATTACHMENT_RETENTION_MS);
}

type OrphanCandidate = { id: string; objectKey: string };
type OrphanSweepDb = Pick<PrismaClient, "attachment">;
type UploadSessionSweepDb = Pick<PrismaClient, "attachmentUploadSession">;

/** One batch of unclaimed attachments older than the cutoff, oldest first. */
export async function orphanAttachmentCandidates(
  db: OrphanSweepDb,
  cutoff: Date,
  take: number = SWEEP_BATCH,
): Promise<OrphanCandidate[]> {
  return db.attachment.findMany({
    where: { messageId: null, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true, objectKey: true },
  });
}

/**
 * Deletes the candidates still unclaimed and returns the object keys of the rows it removed.
 * The `messageId: null` fence is re-checked inside the delete, so a send that committed its
 * claim after {@link orphanAttachmentCandidates} ran keeps its row; survivors are read back by
 * id and their keys stay. A send whose claim lands between this delete and its own update
 * rolls back — the accepted residual race for a draft older than the retention window.
 */
export async function deleteUnclaimedAttachments(
  db: OrphanSweepDb,
  candidates: readonly OrphanCandidate[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((row) => row.id);
  const deleted = await db.attachment.deleteMany({
    where: { id: { in: ids }, messageId: null },
  });
  if (deleted.count === 0) return [];
  const survivors = await db.attachment.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const survivorIds = new Set(survivors.map((row) => row.id));
  return candidates.filter((row) => !survivorIds.has(row.id)).map((row) => row.objectKey);
}

export type OrphanAttachmentSweepStats = {
  candidates: number;
  deleted: number;
  objectRemoveFailures: number;
};

/** Removes stored objects whose rows are already gone; returns how many keys failed. */
async function removeOrphanObjects(
  files: () => Promise<BulkFileRemoval>,
  objectKeys: readonly string[],
): Promise<number> {
  const keys = [...new Set(objectKeys)];
  if (keys.length === 0) return 0;
  try {
    await (await files()).removeMany(keys);
    return 0;
  } catch {
    return keys.length;
  }
}

/**
 * One pass over unclaimed attachments past retention: batched candidate reads and fenced
 * deletes until a short batch or the per-run cap, then one bulk object removal. Every web
 * instance may run it — the delete fence makes overlapping runs harmless.
 */
export async function sweepOrphanedAttachmentRows(
  db: OrphanSweepDb,
  files: () => Promise<BulkFileRemoval>,
  now: Date = new Date(),
): Promise<OrphanAttachmentSweepStats> {
  const cutoff = orphanAttachmentCutoff(now);
  const objectKeys: string[] = [];
  let candidates = 0;
  let deleted = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await orphanAttachmentCandidates(db, cutoff);
    if (rows.length === 0) break;
    candidates += rows.length;
    const keys = await deleteUnclaimedAttachments(db, rows);
    deleted += keys.length;
    objectKeys.push(...keys);
    if (rows.length < SWEEP_BATCH) break;
  }
  const objectRemoveFailures = await removeOrphanObjects(files, objectKeys);
  return { candidates, deleted, objectRemoveFailures };
}

/**
 * Upload sessions abandoned past their own expiry: a `pending` session whose `expiresAt` has
 * passed can never complete (`complete` expires it itself), so the sweep removes the row and
 * its reserved object. `verifying` sessions are never touched — a stuck one is only counted
 * ({@link countVerifyingUploadSessionZombies}) until there is data on how often they occur.
 */
export async function expiredUploadSessionCandidates(
  db: UploadSessionSweepDb,
  now: Date,
  take: number = SWEEP_BATCH,
): Promise<OrphanCandidate[]> {
  return db.attachmentUploadSession.findMany({
    where: { state: "pending", expiresAt: { lt: now } },
    orderBy: { expiresAt: "asc" },
    take,
    select: { id: true, objectKey: true },
  });
}

/**
 * Deletes the candidates still `pending` and returns the object keys of the rows it removed.
 * The `state: "pending"` fence re-checks inside the delete, so a session `complete` claimed
 * for verification after the candidate read keeps its row and its object.
 */
export async function deleteExpiredUploadSessions(
  db: UploadSessionSweepDb,
  candidates: readonly OrphanCandidate[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((row) => row.id);
  const deleted = await db.attachmentUploadSession.deleteMany({
    where: { id: { in: ids }, state: "pending" },
  });
  if (deleted.count === 0) return [];
  const survivors = await db.attachmentUploadSession.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const survivorIds = new Set(survivors.map((row) => row.id));
  return candidates.filter((row) => !survivorIds.has(row.id)).map((row) => row.objectKey);
}

/** `verifying` sessions whose last state change is over an hour old — the zombie count. */
export async function countVerifyingUploadSessionZombies(
  db: UploadSessionSweepDb,
  now: Date,
): Promise<number> {
  return db.attachmentUploadSession.count({
    where: {
      state: "verifying",
      updatedAt: { lt: new Date(now.getTime() - UPLOAD_SESSION_ZOMBIE_MS) },
    },
  });
}

export type OrphanUploadSessionSweepStats = OrphanAttachmentSweepStats & {
  verifyingZombies: number;
};

/** One pass over expired `pending` upload sessions plus the zombie count; see above. */
export async function sweepOrphanedUploadSessions(
  db: UploadSessionSweepDb,
  files: () => Promise<BulkFileRemoval>,
  now: Date = new Date(),
): Promise<OrphanUploadSessionSweepStats> {
  const objectKeys: string[] = [];
  let candidates = 0;
  let deleted = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await expiredUploadSessionCandidates(db, now);
    if (rows.length === 0) break;
    candidates += rows.length;
    const keys = await deleteExpiredUploadSessions(db, rows);
    deleted += keys.length;
    objectKeys.push(...keys);
    if (rows.length < SWEEP_BATCH) break;
  }
  const objectRemoveFailures = await removeOrphanObjects(files, objectKeys);
  const verifyingZombies = await countVerifyingUploadSessionZombies(db, now);
  return { candidates, deleted, objectRemoveFailures, verifyingZombies };
}

let started = false;
let sweeping = false;

/**
 * Every day, sweeps orphaned uploads (task #627). Runs once at start so a process that lives
 * less than a day still collects, then on the interval; a failed run is logged and the next
 * one tries again.
 */
export function ensureAttachmentOrphanSweep(): void {
  if (started) return;
  started = true;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const db = requireDatabaseClient();
      const began = Date.now();
      try {
        const stats = await sweepOrphanedAttachmentRows(db, getFileStorage, new Date());
        console.info(
          JSON.stringify({
            event: "attachment_orphans:swept",
            attachment_candidates: stats.candidates,
            attachments_deleted: stats.deleted,
            object_remove_failures: stats.objectRemoveFailures,
            duration_ms: Date.now() - began,
          }),
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "attachment_orphans:sweep_failed",
            error_type: errorType(error),
          }),
        );
      }
      const sessionsBegan = Date.now();
      try {
        const stats = await sweepOrphanedUploadSessions(db, getFileStorage, new Date());
        console.info(
          JSON.stringify({
            event: "attachment_upload_sessions:swept",
            session_candidates: stats.candidates,
            sessions_deleted: stats.deleted,
            object_remove_failures: stats.objectRemoveFailures,
            verifying_sessions_over_1h: stats.verifyingZombies,
            duration_ms: Date.now() - sessionsBegan,
          }),
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "attachment_upload_sessions:sweep_failed",
            error_type: errorType(error),
          }),
        );
      }
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), ATTACHMENT_ORPHAN_SWEEP_MS);
  timer.unref();
  onServerShutdown(() => clearInterval(timer));
}
