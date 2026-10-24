import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

/** A client, or the client of a transaction already open. */
export type DatabaseScope = PrismaClient | Prisma.TransactionClient;

/** A root client owns commits; a transaction client leaves post-commit work to its caller. */
export function isDatabaseClient(scope: DatabaseScope): scope is PrismaClient {
  return "$transaction" in scope;
}

/** Runs `work` in one transaction: a new one on a client, the caller's own on a transaction
 * client (Prisma does not nest them). */
export function inTransaction<Result>(
  scope: DatabaseScope,
  work: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> {
  return isDatabaseClient(scope) ? scope.$transaction(work) : work(scope);
}
