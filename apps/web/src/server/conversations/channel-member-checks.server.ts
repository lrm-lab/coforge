import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

/**
 * Whether these people and Agents may join a channel of this Workspace: the people are members,
 * the Agents are active and public (a private Agent is never an active channel member). Shared
 * with the atomic create-with-members path, which must refuse before writing anything.
 */
export async function assertChannelMembersAddable(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  input: { userIds: readonly string[]; agentIds: readonly string[] },
) {
  if (input.userIds.length) {
    const validUsers = await db.workspaceMembership.count({
      where: { workspaceId, userId: { in: [...input.userIds] } },
    });
    if (validUsers !== input.userIds.length) throw new AppError("INVALID_INPUT");
  }
  if (input.agentIds.length) {
    const targetAgents = await db.agent.findMany({
      where: { workspaceId, id: { in: [...input.agentIds] }, ...ACTIVE_AGENT_WHERE },
      select: { id: true, visibility: true },
    });
    if (targetAgents.length !== input.agentIds.length) throw new AppError("INVALID_INPUT");
    // A private Agent is never an active channel member — reject the whole add rather than
    // silently drop it, with a stable code + explanation for the caller.
    if (targetAgents.some((agent) => agent.visibility !== AGENT_VISIBILITY.PUBLIC))
      throw new AppError("INVALID_INPUT", { errorId: "agent-private" });
  }
}
