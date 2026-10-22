import type { Prisma } from "#src/generated/prisma/client";
import { AppInstallationSetup } from "#src/server/app-installation-setup/app-installation-setup.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { PrismaAppInstallationSetupStore } from "#src/server/db/repositories/app-installation-setup.repositories.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Installation setup over PostgreSQL, behind the `app-installation-setup` flag. `db` may be an
 * open transaction. */
export function createAppInstallationSetup(db: DatabaseScope) {
  const registry = createAppRegistry(db as Prisma.TransactionClient);
  return new AppInstallationSetup(
    new PrismaAppInstallationSetupStore(db),
    (workspace) => isFeatureEnabled("app-installation-setup", workspace),
    (actor, key) => registry.requireOwnApp(actor, key),
  );
}
