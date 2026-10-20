import type { PrismaClient } from "#src/generated/prisma/client";
import { AppRegistry } from "#src/server/apps/app-registry.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";

/** The app registry over PostgreSQL. */
export function createAppRegistry(db: PrismaClient) {
  return new AppRegistry(new PrismaAppRegistryStore(db));
}
