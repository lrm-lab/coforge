import { createPaginator } from "prisma-extension-pagination";
import { PAGINATION_OPTIONS } from "#src/server/db/pagination.server";

type FakeModel = { findMany: (...args: never[]) => unknown; count?: (...args: never[]) => unknown };

/**
 * A hand-built Prisma stand-in for unit tests, given the `$extends` that `paginated()` calls: each
 * model gains the same `paginate` the real extension adds, running over that model's fake
 * `findMany`/`count`. So a test still asserts on the `findMany` arguments the code sends.
 */
export function withFakePagination<Db extends Record<string, unknown>>(db: Db): Db {
  const paginate = createPaginator(PAGINATION_OPTIONS);
  return Object.assign(db, {
    $extends: () =>
      Object.fromEntries(
        Object.entries(db).map(([name, model]) =>
          model && typeof model === "object" && "findMany" in model
            ? [
                name,
                { ...model, paginate: (args: object) => paginate.call(model as FakeModel, args) },
              ]
            : [name, model],
        ),
      ),
  });
}
