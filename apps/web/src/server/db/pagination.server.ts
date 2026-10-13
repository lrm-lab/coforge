import { pagination } from "prisma-extension-pagination";
import type { PrismaClient } from "#src/generated/prisma/client";

/**
 * `prisma-extension-pagination`, configured for our ids. They are UUID strings, which the
 * extension's default cursor (numeric ids only) refuses to serialize.
 *
 * Use it only for a cursor on a single unique column (`id`): with a compound unique cursor
 * (`conversationId_sequence`, …) Prisma 7 leaves the query without a LIMIT and reads every row
 * before the cursor, so a sequence window stays a plain range query (`sequence < …`).
 */
export const PAGINATION_OPTIONS = {
  cursor: {
    getCursor: ({ id }: { id: string }) => id,
    parseCursor: (cursor: string) => ({ id: cursor }),
  },
};

const paginationExtension = pagination(PAGINATION_OPTIONS);

const extend = (db: PrismaClient) => db.$extends(paginationExtension);

export type PaginatedClient = ReturnType<typeof extend>;

const extended = new WeakMap<PrismaClient, PaginatedClient>();

/** `db` with `.paginate()` on every model. One extended client per base client; it shares the
 * base client's connection pool. */
export function paginated(db: PrismaClient): PaginatedClient {
  let client = extended.get(db);
  if (!client) {
    client = extend(db);
    extended.set(db, client);
  }
  return client;
}
