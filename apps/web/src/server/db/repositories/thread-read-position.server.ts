import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

/** Moves a member's read position in a thread forward to `sequence`, never back. */
export async function advanceThreadRead(
  client: Prisma.TransactionClient | PrismaClient,
  memberId: string,
  conversationId: string,
  workspaceId: string,
  rootMessageId: string,
  sequence: number,
) {
  // PostgreSQL's atomic upsert preserves monotonic positions across backend replicas.
  await client.$executeRaw`INSERT INTO "thread_reads"
    ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
    VALUES (${memberId}::uuid, ${conversationId}::uuid, ${workspaceId}::uuid, ${rootMessageId}::uuid, ${sequence})
    ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
      GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
}

/** Where a member's read position stands: the thread's when `threadRootId` names one, else the
 * conversation's (`conversationReadThrough`). */
export async function readThroughOf(
  db: Pick<PrismaClient, "threadRead">,
  memberId: string,
  conversationReadThrough: number,
  threadRootId: string | null,
) {
  if (!threadRootId) return conversationReadThrough;
  const threadRead = await db.threadRead.findUnique({
    where: { memberId_rootMessageId: { memberId, rootMessageId: threadRootId } },
    select: { readThroughSequence: true },
  });
  return threadRead?.readThroughSequence ?? 0;
}

/** Moves an Agent's read position forward to `sequence`, in the thread `threadRootId` names or else
 * in the conversation, never back. */
export async function advanceAgentRead(
  db: PrismaClient,
  read: {
    memberId: string;
    conversationId: string;
    workspaceId: string;
    agentId: string;
    threadRootId: string | null;
    sequence: number;
  },
) {
  const { memberId, conversationId, workspaceId, agentId, threadRootId, sequence } = read;
  if (threadRootId) {
    await advanceThreadRead(db, memberId, conversationId, workspaceId, threadRootId, sequence);
    return true;
  }
  const result = await db.conversationMember.updateMany({
    where: { conversationId, agentId, agentReadThroughSequence: { lt: sequence } },
    data: { agentReadThroughSequence: sequence },
  });
  return result.count > 0;
}
