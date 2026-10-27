import type { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";

/**
 * The Agents a sent channel message wakes, the same for a person's post and an Agent's. (A Task
 * and an action card keep their own rules: `server/tasks/task-board.server.ts` and
 * `action-cards.server.ts`.)
 *
 * Directed delivery wakes the mentioned Agents immediately (a mention pierces mute).
 * The active Workspace Memory Agent additionally observes channel Messages through batched
 * notices; its daemon coalesces ordinary updates and reads their bodies with message_read.
 * Mentioning only humans never narrows ordinary Agent delivery.
 *
 * Without an Agent mention the audience depends on what the message *is*: a top-level message
 * belongs to the channel, so every unmuted Agent member receives it; a reply belongs to its
 * thread, so it reaches the thread's **followers** — whoever replied, everyone a reply mentioned,
 * and the thread's root author. Reaching the whole channel from inside a thread meant a human
 * replying to one Agent woke every unmuted Agent in it (reported 2026-09-21). A root author who
 * explicitly unfollowed stays out, which is why this reads follows and not authorship.
 *
 * An Agent sender never wakes itself. Read after the send enrolls its thread followers.
 */
export async function channelAgentRecipients(
  tx: Prisma.TransactionClient,
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
                ? { threadFollows: { some: { rootMessageId: message.threadRootId } } }
                : { channelMuted: false }),
            },
            select: { agentId: true },
          })
        ).map(({ agentId }) => agentId!);
  const observers = await tx.conversationMember.findMany({
    where: {
      conversationId: message.conversationId,
      ...ACTIVE_MEMBER_WHERE,
      agent: {
        ...ACTIVE_AGENT_WHERE,
        stoppedAt: null,
        workspaceMemoryAgent: { isNot: null },
        workspace: { memoryProfile: { is: { desired: "openviking" } } },
      },
    },
    select: { agentId: true },
  });
  return [
    ...new Set([
      ...ids,
      ...observers.flatMap((member) => (member.agentId ? [member.agentId] : [])),
    ]),
  ].filter((id) => id !== message.senderAgentId);
}
