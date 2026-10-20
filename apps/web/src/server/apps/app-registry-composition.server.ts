import type { PrismaClient } from "#src/generated/prisma/client";
import { AppRegistry } from "#src/server/apps/app-registry.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";

/** The app registry over PostgreSQL, keeping logos in the public image store (as Agent avatars
 * are) and reporting an old logo it could not remove as a server error. */
export function createAppRegistry(db: PrismaClient) {
  return new AppRegistry(new PrismaAppRegistryStore(db), {
    storage: getPublicImageStorage,
    removalFailed: (error) => void toPublicServerError(error),
  });
}
