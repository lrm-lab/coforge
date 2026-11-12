import type { PrismaClient } from "#src/generated/prisma/client";

/** The backfill's batch size: one indexed range of `message_forwards` per round, small enough
 * that each UPDATE stays short-lived (the lock-timeout rule a migration would have needed). */
const BACKFILL_BATCH = 500;

export type ForwardSenderBackfillSummary = {
  scanned: number;
  /** Rows the run filled — in a dry run, the rows it would have filled. */
  filled: number;
  /** Rows whose carrying message the read could not find; they stay NULL for a rerun or a look. */
  skipped: number;
  batches: number;
  /** The last messageId the run reached; pass it back as `afterMessageId` to continue a rerun. */
  lastMessageId: string | null;
};

/**
 * Fills `message_forwards.workspaceId` and `senderUserId` for rows a pre-#78 Web instance wrote
 * without the columns (a rolling deploy), and for anything its backfill migration never reached:
 * the columns are nullable until release two sets NOT NULL (task #78's review). Each batch reads
 * the rows still missing `workspaceId` in `messageId` keyset order — `afterMessageId` resumes a
 * run where `lastMessageId` stopped — resolves the carrying message's Workspace and its sender's
 * User id through their own indexed reads, and updates just those rows — never an
 * `UPDATE ... FROM messages` in a migration, which the size ratchet refuses on a large table.
 * Repeatable: the scan's WHERE is the missing rows themselves, and the cursor keeps a dry run or
 * an orphan row from looping on the same first batch.
 */
export async function backfillForwardSenders(input: {
  db: PrismaClient;
  dryRun: boolean;
  batchSize?: number;
  afterMessageId?: string;
}): Promise<ForwardSenderBackfillSummary> {
  const { db, dryRun } = input;
  const batchSize = input.batchSize ?? BACKFILL_BATCH;
  const summary: ForwardSenderBackfillSummary = {
    scanned: 0,
    filled: 0,
    skipped: 0,
    batches: 0,
    lastMessageId: input.afterMessageId ?? null,
  };
  let cursor = input.afterMessageId ?? null;
  for (;;) {
    const batch = await db.messageForward.findMany({
      where: { workspaceId: null, ...(cursor ? { messageId: { gt: cursor } } : {}) },
      orderBy: { messageId: "asc" },
      take: batchSize,
      select: { messageId: true },
    });
    if (batch.length === 0) break;
    summary.batches += 1;
    summary.scanned += batch.length;
    cursor = batch.at(-1)!.messageId;
    summary.lastMessageId = cursor;
    // One row per carrying message: every forward row on it shares the message's Workspace and
    // sender, so the resolution is a single indexed read per batch's distinct messages.
    const carries = await db.message.findMany({
      where: { id: { in: [...new Set(batch.map(({ messageId }) => messageId))] } },
      select: {
        id: true,
        workspaceId: true,
        sender: { select: { userId: true } },
      },
    });
    const byMessageId = new Map(carries.map((message) => [message.id, message]));
    const fillableIds = [
      ...new Set(batch.map(({ messageId }) => messageId).filter((id) => byMessageId.has(id))),
    ];
    summary.skipped += batch.filter(({ messageId }) => !byMessageId.has(messageId)).length;
    if (dryRun) {
      // The count covers every missing row on the batch's fillable messages, including rows a
      // batch boundary kept back — the same rows --apply's per-message updateMany would write.
      if (fillableIds.length > 0) {
        summary.filled += await db.messageForward.count({
          where: { messageId: { in: fillableIds }, workspaceId: null },
        });
      }
    } else {
      for (const messageId of fillableIds) {
        const message = byMessageId.get(messageId)!;
        const filled = await db.messageForward.updateMany({
          where: { messageId, workspaceId: null },
          data: { workspaceId: message.workspaceId, senderUserId: message.sender?.userId ?? null },
        });
        summary.filled += filled.count;
      }
    }
    if (batch.length < batchSize) break;
  }
  return summary;
}
