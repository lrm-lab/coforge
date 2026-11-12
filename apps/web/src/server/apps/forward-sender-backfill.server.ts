import type { PrismaClient } from "#src/generated/prisma/client";

/** The backfill's batch size: one indexed range of `message_forwards` per round, small enough
 * that each UPDATE stays short-lived (the lock-timeout rule a migration would have needed). */
const BACKFILL_BATCH = 500;

export type ForwardSenderBackfillSummary = {
  scanned: number;
  filled: number;
  batches: number;
  /** The last messageId the run reached, so a rerun continues instead of rescanning. */
  lastMessageId: string | null;
};

/**
 * Fills `message_forwards.workspaceId` and `senderUserId` for rows a pre-#78 Web instance wrote
 * without the columns (a rolling deploy), and for anything its backfill migration never reached:
 * the columns are nullable until release two sets NOT NULL (task #78's review). Each batch reads
 * the rows still missing `workspaceId` in `messageId` order, resolves the carrying message's
 * Workspace and its sender's User id through their own indexed reads, and updates just those rows
 * — never an `UPDATE ... FROM messages` in a migration, which the size ratchet refuses on a large
 * table. Repeatable: the scan's WHERE is the missing rows themselves.
 */
export async function backfillForwardSenders(input: {
  db: PrismaClient;
  dryRun: boolean;
  batchSize?: number;
}): Promise<ForwardSenderBackfillSummary> {
  const { db, dryRun } = input;
  const batchSize = input.batchSize ?? BACKFILL_BATCH;
  const summary: ForwardSenderBackfillSummary = {
    scanned: 0,
    filled: 0,
    batches: 0,
    lastMessageId: null,
  };
  for (;;) {
    const batch = await db.messageForward.findMany({
      where: { workspaceId: null },
      orderBy: { messageId: "asc" },
      take: batchSize,
      select: { messageId: true },
    });
    if (batch.length === 0) break;
    summary.batches += 1;
    summary.scanned += batch.length;
    summary.lastMessageId = batch.at(-1)!.messageId;
    if (dryRun) continue;
    // One row per carrying message: every forward row on it shares the message's Workspace and
    // sender, so the resolution is a single indexed read per batch's distinct messages.
    const carries = await db.message.findMany({
      where: { id: { in: batch.map(({ messageId }) => messageId) } },
      select: {
        id: true,
        workspaceId: true,
        sender: { select: { userId: true } },
      },
    });
    const byMessageId = new Map(carries.map((message) => [message.id, message]));
    for (const { messageId } of batch) {
      const message = byMessageId.get(messageId);
      if (!message) continue;
      const filled = await db.messageForward.updateMany({
        where: { messageId, workspaceId: null },
        data: { workspaceId: message.workspaceId, senderUserId: message.sender?.userId ?? null },
      });
      summary.filled += filled.count;
    }
    if (batch.length < batchSize) break;
  }
  return summary;
}
