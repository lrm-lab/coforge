import type { Prisma } from "#src/generated/prisma/client";
import { AppPublishing } from "#src/server/app-marketplace/app-publishing.server";
import { PrismaAppPublishingStore } from "#src/server/db/repositories/app-publishing.repositories.server";

/** Marketplace review over PostgreSQL. */
export function createAppPublishing(db: Prisma.TransactionClient) {
  return new AppPublishing(new PrismaAppPublishingStore(db));
}
