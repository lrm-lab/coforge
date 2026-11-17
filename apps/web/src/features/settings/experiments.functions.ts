import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { EXPERIMENT_KEYS, Experiments } from "#src/server/experiments/experiments.server";
import { canManageWorkspaceSettings } from "#src/features/workspaces/workspace-roles";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { announceFeaturesChanged } from "#src/server/experiments/features-signal.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
const setExperimentInputSchema = z.object({
  key: z.enum(EXPERIMENT_KEYS),
  enabled: z.boolean(),
});
async function experimentsFor(db: PrismaClient, workspaceId: string) {
  const { slug } = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { slug: true },
  });
  return {
    experiments: new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled),
    workspace: { workspaceId, workspaceSlug: slug },
  };
}
export const getExperiments = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { experiments, workspace } = await experimentsFor(context.db, context.workspaceId);
    const role = await workspaceMemberRole(context.db, context.workspaceId, context.user.id);
    return {
      experiments: await experiments.list(workspace),
      canManage: canManageWorkspaceSettings(role),
    };
  });
export const setExperiment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(setExperimentInputSchema)
  .handler(async ({ data, context }) => {
    const { experiments, workspace } = await experimentsFor(context.db, context.workspaceId);
    const role = await workspaceMemberRole(context.db, context.workspaceId, context.user.id);

    const view = await experiments.set(workspace, role, data.key, data.enabled);
    await announceFeaturesChanged(createCentrifugoServerApi(), context.workspaceId);
    return view;
  });
