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

/**
 * Which of these people and Agents may join a channel of this Workspace (`assertChannelMembersAddable`'s
 * rule): the people that are members, the Agents that are active and public — and the ones that
 * cannot, each with its reason. The add-reports-refusals path partitions once, then adds the
 * addable set in one call so one action posts at most one membership record.
 */
export async function partitionAddableChannelMembers(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  input: { userIds: readonly string[]; agentIds: readonly string[] },
): Promise<{
  addable: { userIds: string[]; agentIds: string[] };
  refused: {
    kind: "user" | "agent";
    id: string;
    reason: "not_in_workspace" | "agent_inactive" | "agent_private";
  }[];
}> {
  const memberIds = new Set(
    input.userIds.length
      ? (
          await db.workspaceMembership.findMany({
            where: { workspaceId, userId: { in: [...input.userIds] } },
            select: { userId: true },
          })
        ).map((row) => row.userId)
      : [],
  );
  const agents = input.agentIds.length
    ? await db.agent.findMany({
        where: { workspaceId, id: { in: [...input.agentIds] }, ...ACTIVE_AGENT_WHERE },
        select: { id: true, visibility: true },
      })
    : [];
  const liveAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const refused: {
    kind: "user" | "agent";
    id: string;
    reason: "not_in_workspace" | "agent_inactive" | "agent_private";
  }[] = [];
  for (const id of input.userIds)
    if (!memberIds.has(id)) refused.push({ kind: "user", id, reason: "not_in_workspace" });
  for (const id of input.agentIds) {
    const agent = liveAgents.get(id);
    if (!agent) refused.push({ kind: "agent", id, reason: "agent_inactive" });
    else if (agent.visibility !== AGENT_VISIBILITY.PUBLIC)
      refused.push({ kind: "agent", id, reason: "agent_private" });
  }
  const refusedIds = new Set(refused.map((row) => row.id));
  return {
    addable: {
      userIds: input.userIds.filter((id) => !refusedIds.has(id)),
      agentIds: input.agentIds.filter((id) => !refusedIds.has(id)),
    },
    refused,
  };
}
