import type { Prisma } from "#src/generated/prisma/client";
import { AppRegistry } from "#src/server/apps/app-registry.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";
import { PrismaAppPublishingStore } from "#src/server/db/repositories/app-publishing.repositories.server";

/** The app registry over PostgreSQL (`db` may be an open transaction), keeping logos in the public image store (as user avatars
 * are) and reporting an old logo it could not remove as a server error. A platform reviewer also
 * reads the logo of an app with a request waiting (`server/app-marketplace/`). */
export function createAppRegistry(db: Prisma.TransactionClient) {
  return new AppRegistry(
    new PrismaAppRegistryStore(db),
    {
      storage: getPublicImageStorage,
      removalFailed: (error) => void toPublicServerError(error),
    },
    {
      agentManifestEnabled: (workspace) => isFeatureEnabled("app-agent-manifest", workspace),
      findReviewLogo: (input) => new PrismaAppPublishingStore(db).findLogoForReview(input),
    },
  );
}
