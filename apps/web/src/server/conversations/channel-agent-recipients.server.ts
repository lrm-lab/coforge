import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";

export async function channelAgentRecipients(
  tx: Pick<PrismaClient, "conversation" | "conversationMember">,
  message: {
    conversationId: string;
    threadRootId: string | undefined;
    mentions: readonly { type: string; id: string }[];
    senderAgentId?: string;
  },
): Promise<string[]> {
  const mentioned = message.mentions
    .filter((mention) => mention.type === "agent")
    .map((mention) => mention.id);
  // A member's Agent is always in the conversation's Workspace (both foreign keys carry it), so
  // no Agent join is needed here.
  const coordinator =
    !mentioned.length && !message.threadRootId
      ? await tx.conversation.findFirst({
          where: {
            id: message.conversationId,
            coordinatorAgentId: { not: null },
            coordinatorAgent: ACTIVE_AGENT_WHERE,
          },
          select: { coordinatorAgentId: true },
        })
      : null;
  const activeCoordinator = coordinator?.coordinatorAgentId
    ? await tx.conversationMember.findFirst({
        where: {
          conversationId: message.conversationId,
          agentId: coordinator.coordinatorAgentId,
          ...ACTIVE_MEMBER_WHERE,
        },
        select: { agentId: true },
      })
    : null;
  const ids = mentioned.length
    ? mentioned
    : activeCoordinator?.agentId
      ? [activeCoordinator.agentId]
      : (
          await tx.conversationMember.findMany({
            where: {
              conversationId: message.conversationId,
              agentId: { not: null },
              ...ACTIVE_MEMBER_WHERE,
              ...(message.threadRootId
                ? {
                    threadFollows: {
                      some: { rootMessageId: message.threadRootId, unfollowedAt: null },
                    },
                  }
                : { notificationLevel: "all" }),
            },
            select: { agentId: true },
          })
        ).map(({ agentId }) => agentId!);
  return [...new Set(ids)].filter((id) => id !== message.senderAgentId);
}
