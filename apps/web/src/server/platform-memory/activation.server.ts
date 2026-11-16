import type { PrismaClient } from "#src/generated/prisma/client";
import { readPlatformMemoryPreference } from "#src/server/db/repositories/platform-memory-preferences.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

export async function platformMemoryEnabled(
  db: PrismaClient,
  scope: { workspaceId: string; ownerId?: string },
) {
  const [workspaceEnabled, ownerEnabled] = await Promise.all([
    new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
      "platformMemory",
      { workspaceId: scope.workspaceId },
    ),
    scope.ownerId ? readPlatformMemoryPreference(db, scope.ownerId) : true,
  ]);
  return workspaceEnabled && ownerEnabled;
}
