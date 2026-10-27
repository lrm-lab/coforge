import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppBot } from "#src/features/agents/agent-system-kind";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import {
  agentVisibilityViewerForUser,
  assertAgentVisible,
  managedAgentWhere,
  type AgentVisibilityViewer,
} from "./agent-visibility.server";

/**
 * Lets the viewer read an Agent's Chat tab (its channels and its conversations with other Agents),
 * and answers the viewer for the caller's own per-row visibility checks. The tab's own rule: an
 * ordinary Agent's Chat shows where its Activity does, to its creator and a Workspace owner/admin
 * (the client's `canManageAgent`); an app's bot, which has no Activity, shows it to everyone who
 * can see the Agent. A missing, deleted, unseen or refused Agent all answer `AGENT_NOT_VISIBLE`,
 * so a caller cannot tell them apart.
 */
export async function assertAgentChatReadable(
  db: Pick<PrismaClient, "agent" | "workspaceMembership">,
  input: { workspaceId: string; agentId: string; userId: string },
): Promise<AgentVisibilityViewer> {
  const { workspaceId, agentId, userId } = input;
  const [viewer, subject] = await Promise.all([
    agentVisibilityViewerForUser(db, workspaceId, userId),
    db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { visibility: true, ownerId: true, systemKind: true },
    }),
  ]);
  if (!subject) throw new AppError("AGENT_NOT_VISIBLE");
  assertAgentVisible(viewer, subject);
  if (isAppBot(subject)) return viewer;
  // The same rule as the Agent card's Activity (`managedAgentWhere`), so the two never disagree.
  const managed = await db.agent.findFirst({
    where: { id: agentId, ...managedAgentWhere({ userId, workspaceId }) },
    select: { id: true },
  });
  if (!managed) throw new AppError("AGENT_NOT_VISIBLE");
  return viewer;
}
