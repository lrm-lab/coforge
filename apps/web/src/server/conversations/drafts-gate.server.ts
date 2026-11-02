import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Whether the Drafts page applies in the Workspace: on unless its owner or an admin switched the
 * `drafts` experiment off, for everyone in it. */
export function draftsEnabled(db: PrismaClient, principal: { workspaceId: string }) {
  return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled("drafts", {
    workspaceId: principal.workspaceId,
  });
}
