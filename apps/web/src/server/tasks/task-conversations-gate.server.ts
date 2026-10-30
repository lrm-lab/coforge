import type { PrismaClient } from "#src/generated/prisma/client";
import type { TaskPrincipal } from "@lrm/coforge-sdk/internal";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/**
 * Whether task conversations apply to this principal: the `taskConversations` experiment is on for
 * them (a person) or for their owner (an Agent) in the Workspace. An Agent follows its owner's
 * switch, not the switch of whoever it talks to.
 */
export async function taskConversationsEnabled(
  db: PrismaClient,
  principal: Pick<TaskPrincipal, "workspaceId" | "userId" | "agentId">,
) {
  const [workspace, userId] = await Promise.all([
    db.workspace.findUnique({ where: { id: principal.workspaceId }, select: { slug: true } }),
    principal.agentId
      ? db.agent
          .findFirst({
            where: { id: principal.agentId, workspaceId: principal.workspaceId },
            select: { ownerId: true },
          })
          .then((agent) => agent?.ownerId)
      : principal.userId,
  ]);
  if (!workspace || !userId) return false;
  return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
    "taskConversations",
    userId,
    { workspaceId: principal.workspaceId, workspaceSlug: workspace.slug },
  );
}

/** `taskConversationsEnabled` for one Agent, as the gate the task conversation routes take. */
export function taskConversationsGate(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
) {
  return () => taskConversationsEnabled(db, principal);
}
