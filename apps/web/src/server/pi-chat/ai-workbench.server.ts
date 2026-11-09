import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Whether the Workspace has AI Workbench on: on unless its owner or an admin switched the
 * `aiWorkbench` experiment off, for everyone in it (Frank, 11-09). */
export function isAiWorkbenchEnabled(db: PrismaClient, workspaceId: string) {
  return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
    "aiWorkbench",
    { workspaceId },
  );
}

/** Refuses a Workspace whose AI Workbench switch is off; every Workbench entry calls it. */
export async function requireAiWorkbench(db: PrismaClient, workspaceId: string) {
  if (!(await isAiWorkbenchEnabled(db, workspaceId))) throw new AppError("ACCESS_DENIED");
}
