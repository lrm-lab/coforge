import type { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { leftoverMentionHandles } from "./unresolved-mentions.server";

/** How long the sender can act on a mention that did not reach its target. */
export const PENDING_MENTION_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * In the send transaction, record each non-member human/public-Agent @handle left after
 * member mentions became tokens. Private Agents get none; a public Agent wins a name clash.
 * Message replay creates no duplicates.
 */
export async function recordPendingMentionActions(
  tx: Pick<Prisma.TransactionClient, "workspaceMembership" | "agent" | "pendingMentionAction">,
  message: {
    id: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    body: string;
    createdAt: Date;
  },
  /** Bindings the send could not resolve to a member mention — a member who left between the
   * caller's read and the send's — given the same pending action as an unresolvable `@handle`.
   * Ids the caller shaped but this Workspace does not have are dropped: a binding can name
   * anything, and a row it does not belong to would break the FK or leak another Workspace. */
  unboundTargets: readonly {
    targetUserId?: string;
    targetAgentId?: string;
    targetHandle: string;
  }[] = [],
): Promise<void> {
  const handles = leftoverMentionHandles(message.body);
  if (!handles.length && !unboundTargets.length) return;
  const unboundUserIds = unboundTargets.flatMap((target) =>
    target.targetUserId ? [target.targetUserId] : [],
  );
  const unboundAgentIds = unboundTargets.flatMap((target) =>
    target.targetAgentId ? [target.targetAgentId] : [],
  );
  const [humans, agents, unboundUsers, unboundAgents] = await Promise.all([
    tx.workspaceMembership.findMany({
      where: { workspaceId: message.workspaceId, user: { username: { in: handles } } },
      select: { user: { select: { id: true, username: true } } },
    }),
    tx.agent.findMany({
      where: {
        workspaceId: message.workspaceId,
        name: { in: handles },
        visibility: AGENT_VISIBILITY.PUBLIC,
        ...ACTIVE_AGENT_WHERE,
      },
      select: { id: true, name: true },
    }),
    unboundUserIds.length
      ? tx.workspaceMembership.findMany({
          where: { workspaceId: message.workspaceId, userId: { in: unboundUserIds } },
          select: { userId: true },
        })
      : [],
    unboundAgentIds.length
      ? tx.agent.findMany({
          where: { workspaceId: message.workspaceId, id: { in: unboundAgentIds } },
          select: { id: true },
        })
      : [],
  ]);
  const agentByHandle = new Map(agents.map((agent) => [agent.name, agent.id]));
  const userByHandle = new Map(humans.map(({ user }) => [user.username, user.id]));
  const expiresAt = new Date(message.createdAt.getTime() + PENDING_MENTION_ACTION_TTL_MS);
  const rows = handles.flatMap((handle) => {
    const agentId = agentByHandle.get(handle);
    const userId = agentId ? undefined : userByHandle.get(handle);
    if (!agentId && !userId) return [];
    return [
      {
        messageId: message.id,
        conversationId: message.conversationId,
        workspaceId: message.workspaceId,
        senderMemberId: message.senderMemberId,
        targetAgentId: agentId,
        targetUserId: userId,
        targetHandle: handle,
        expiresAt,
      },
    ];
  });
  const unboundUserOk = new Set(unboundUsers.map((row) => row.userId));
  const unboundAgentOk = new Set(unboundAgents.map((row) => row.id));
  for (const target of unboundTargets) {
    if (target.targetUserId && !unboundUserOk.has(target.targetUserId)) continue;
    if (target.targetAgentId && !unboundAgentOk.has(target.targetAgentId)) continue;
    rows.push({
      messageId: message.id,
      conversationId: message.conversationId,
      workspaceId: message.workspaceId,
      senderMemberId: message.senderMemberId,
      targetAgentId: target.targetAgentId,
      targetUserId: target.targetUserId,
      targetHandle: target.targetHandle,
      expiresAt,
    });
  }
  if (rows.length) await tx.pendingMentionAction.createMany({ data: rows, skipDuplicates: true });
}

/** The `unboundTargets` a send's mention `bindings` leave: every binding that stored no member
 * mention (its member left before the in-transaction resolution), as the pending-action
 * target shape. */
export function unboundMentionTargets(
  bindings: readonly { type: string; id: string; name: string }[],
  mentions: readonly { type: string; id: string }[],
) {
  return bindings
    .filter(
      (binding) =>
        !mentions.some(
          (mention) =>
            mention.type === binding.type && mention.id.toLowerCase() === binding.id.toLowerCase(),
        ),
    )
    .map((binding) => ({
      targetUserId: binding.type === "user" ? binding.id : undefined,
      targetAgentId: binding.type === "agent" ? binding.id : undefined,
      targetHandle: binding.name,
    }));
}
