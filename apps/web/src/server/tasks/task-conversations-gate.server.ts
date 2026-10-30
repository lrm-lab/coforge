import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/**
 * Whether the Agent's owner has the `taskConversations` experiment on in the Agent's Workspace: an
 * Agent follows its owner's switch, not the switch of whoever it talks to.
 */
export function taskConversationsGate(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
) {
  return async () => {
    const agent = await db.agent.findFirst({
      where: { id: principal.agentId, workspaceId: principal.workspaceId },
      select: { ownerId: true, workspace: { select: { slug: true } } },
    });
    if (!agent) return false;
    return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
      "taskConversations",
      agent.ownerId,
      { workspaceId: principal.workspaceId, workspaceSlug: agent.workspace.slug },
    );
  };
}
