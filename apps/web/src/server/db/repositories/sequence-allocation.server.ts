import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

/**
 * First of `count` consecutive sequences for a conversation; holds the conversation row lock
 * until the transaction ends. `lastSequence` is the sole source; the `MAX(sequence)` only
 * floors it when a deployment window or a direct test insert left the counter behind — one
 * unique-index probe inside the same statement, no extra round trip. A rejected send rolls
 * the increment back with its transaction, leaving no gap.
 * Exported so other message-anchored writers (e.g. `ActionCards.prepare`) serialize through
 * the same lock instead of reimplementing sequence allocation.
 */
export async function allocateSequences(
  tx: Prisma.TransactionClient,
  conversationId: string,
  count = 1,
): Promise<number> {
  const [allocated] = await tx.$queryRaw<[{ first: number }]>`
    UPDATE "conversations"
    SET "lastSequence" = GREATEST(
          "lastSequence",
          (SELECT COALESCE(MAX("sequence"), 0) FROM "messages" WHERE "conversationId" = "conversations"."id")
        ) + ${count}
    WHERE "id" = ${conversationId}::uuid
    RETURNING "lastSequence" - ${count} + 1 AS "first"
  `;
  if (!allocated) throw new AppError("NOT_FOUND");
  return allocated.first;
}

export function allocateSequence(tx: Prisma.TransactionClient, conversationId: string) {
  return allocateSequences(tx, conversationId);
}
