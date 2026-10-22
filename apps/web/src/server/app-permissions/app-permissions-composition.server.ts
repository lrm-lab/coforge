import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppEditorSave } from "#src/server/app-permissions/app-editor-save.server";
import { AppPermissions } from "#src/server/app-permissions/app-permissions.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { PrismaAppPermissionsStore } from "#src/server/db/repositories/app-permissions.repositories.server";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** App permissions over PostgreSQL, behind the `app-data-permissions` flag. `db` may be an open
 * transaction. */
export function createAppPermissions(db: DatabaseScope) {
  const registry = createAppRegistry(db as Prisma.TransactionClient);
  return new AppPermissions(
    new PrismaAppPermissionsStore(db),
    (workspace) => isFeatureEnabled("app-data-permissions", workspace),
    (actor, key) => registry.requireOwnApp(actor, key),
  );
}

/** The editor's Save over PostgreSQL: one transaction for the profile and the permissions. */
export function createAppEditorSave(db: PrismaClient) {
  return new AppEditorSave((work) =>
    inTransaction(db, (tx) =>
      work({ registry: createAppRegistry(tx), permissions: createAppPermissions(tx) }),
    ),
  );
}
