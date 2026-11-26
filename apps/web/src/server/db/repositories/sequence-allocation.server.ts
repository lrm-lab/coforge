import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

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

export async function allocateOneSequenceEach(
  tx: Prisma.TransactionClient,
  conversationIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(conversationIds)].sort();
  if (ids.length === 0) return new Map();
  if (ids.length === 1) {
    const id = ids[0]!;
    return new Map([[id, await allocateSequence(tx, id)]]);
  }
  const allocated = await tx.$queryRaw<Array<{ id: string; sequence: number }>>`
    UPDATE "conversations"
    SET "lastSequence" = GREATEST(
          "lastSequence",
          (SELECT COALESCE(MAX("sequence"), 0) FROM "messages" WHERE "conversationId" = "conversations"."id")
        ) + 1
    WHERE "id" = ANY(${ids}::uuid[])
    RETURNING "id", "lastSequence" AS "sequence"
  `;
  if (allocated.length !== ids.length) throw new AppError("NOT_FOUND");
  return new Map(allocated.map((row) => [row.id, row.sequence]));
}
