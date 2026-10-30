import type { PrismaClient } from "#src/generated/prisma/client";
import type { TaskPrincipal } from "@lrm/coforge-sdk/internal";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** Whether task conversations apply in the principal's Workspace: its owner or an admin switched
 * the `taskConversations` experiment on, for everyone and every Agent in it. */
export async function taskConversationsEnabled(
  db: PrismaClient,
  principal: Pick<TaskPrincipal, "workspaceId">,
) {
  const workspace = await db.workspace.findUnique({
    where: { id: principal.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return false;
  return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
    "taskConversations",
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
