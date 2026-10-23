import type { PrismaClient } from "#src/generated/prisma/client";
import { AppInstallations } from "#src/server/app-marketplace/app-installations.server";
import { createAppPermissions } from "#src/server/app-permissions/app-permissions-composition.server";
import { PrismaAppInstallationStore } from "#src/server/db/repositories/app-installation.repositories.server";
import { inTransaction } from "#src/server/db/transaction.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Marketplace installs over PostgreSQL, behind `app-marketplace`; an install and its approval
 * (`app-data-permissions`) share one transaction. */
export function createAppInstallations(db: PrismaClient) {
  return new AppInstallations(
    (work) =>
      inTransaction(db, (tx) =>
        work({ store: new PrismaAppInstallationStore(tx), permissions: createAppPermissions(tx) }),
      ),
    (workspace) => isFeatureEnabled("app-marketplace", workspace),
    (workspace) => isFeatureEnabled("app-data-permissions", workspace),
  );
}
