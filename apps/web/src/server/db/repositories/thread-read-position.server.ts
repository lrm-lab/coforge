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
