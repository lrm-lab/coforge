import type { Prisma } from "#src/generated/prisma/client";
import { AppPublishing } from "#src/server/app-marketplace/app-publishing.server";
import { PrismaAppPublishingStore } from "#src/server/db/repositories/app-publishing.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Marketplace review over PostgreSQL, behind the `app-marketplace` flag. */
export function createAppPublishing(db: Prisma.TransactionClient) {
  return new AppPublishing(new PrismaAppPublishingStore(db), (workspace) =>
    isFeatureEnabled("app-marketplace", workspace),
  );
}
