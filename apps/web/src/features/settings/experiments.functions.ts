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
import { requireComputersForTaskConversations } from "#src/server/tasks/task-computer-gate.server";
import {
  enableMemoryAgentForWorkspace,
  rollbackMemoryAgentEnable,
} from "#src/server/workspace-memory/default-memory-agent.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

const setExperimentInputSchema = z.object({
  key: z.enum(EXPERIMENT_KEYS),
  enabled: z.boolean(),
});

/** The Workspace is the one the page is in; the flag may target it by id or slug. */
async function experimentsFor(db: PrismaClient, workspaceId: string) {
  const { slug } = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { slug: true },
  });
  return {
    experiments: new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled, {
      taskConversations: (id) => requireComputersForTaskConversations(db, id),
    }),
    workspace: { workspaceId, workspaceSlug: slug },
  };
}

/** Settings → Experiments: what this Workspace offers and its switches; `canManage` says whether
 * the viewer may change them (owner or admin). */
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

/** Switches an experiment for the whole Workspace; owner or admin only. */
export const setExperiment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(setExperimentInputSchema)
  .handler(async ({ data, context }) => {
    const { experiments, workspace } = await experimentsFor(context.db, context.workspaceId);
    const role = await workspaceMemberRole(context.db, context.workspaceId, context.user.id);
    // The Memory Agent's own switch creates the Agent the switch is about (task #6). If storing the
    // choice then fails, the creation goes with it: a Workspace must not be left with an Agent for
    // an experiment it never switched on.
    const created =
      data.key === "memoryAgent" && data.enabled
        ? await enableMemoryAgentForWorkspace(context.db, context.workspaceId, context.user.id)
        : undefined;
    try {
      const view = await experiments.set(workspace, role, data.key, data.enabled);
      await announceFeaturesChanged(createCentrifugoServerApi(), context.workspaceId);
      return view;
    } catch (error) {
      if (created)
        await rollbackMemoryAgentEnable(context.db, {
          workspaceId: context.workspaceId,
          agentId: created,
          deletedByUserId: context.user.id,
        });
      throw error;
    }
  });
