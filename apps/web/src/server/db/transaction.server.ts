import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

/** A client, or the client of a transaction already open. */
export type DatabaseScope = PrismaClient | Prisma.TransactionClient;

/** Runs `work` in one transaction: a new one on a client, the caller's own on a transaction
 * client (Prisma does not nest them). */
export function inTransaction<Result>(
  scope: DatabaseScope,
  work: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> {
  return "$transaction" in scope ? scope.$transaction(work) : work(scope);
}
