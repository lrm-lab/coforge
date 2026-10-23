import type { Prisma } from "#src/generated/prisma/client";
import { AppShareLinks } from "#src/server/app-marketplace/app-share-links.server";
import { PrismaAppShareLinkStore } from "#src/server/db/repositories/app-share-link.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Private share links over PostgreSQL, behind the `app-marketplace` flag. */
export function createAppShareLinks(db: Prisma.TransactionClient) {
  return new AppShareLinks(new PrismaAppShareLinkStore(db), (workspace) =>
    isFeatureEnabled("app-marketplace", workspace),
  );
}
