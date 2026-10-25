import type { PrismaClient } from "#src/generated/prisma/client";

/** How many unread messages one Agent recovery batch carries at most. */
export const AGENT_RECOVERY_MESSAGE_LIMIT = 100;

/** One message of the Agent recovery query, with its ranks and the names its address is built from. */
export type AgentRecoveryRow = {
  id: string;
  sequence: number;
  body: string;
  conversationId: string;
  threadRootId: string | null;
  senderMemberId: string | null;
  createdAt: Date;
  deliveryId: string | null;
  senderAgentName: string | null;
  senderAgentDescription: string | null;
  senderUsername: string | null;
  senderUserDescription: string | null;
  channelName: string | null;
  /** The conversation's other active member: the address a DM reply targets. */
  otherUsername: string | null;
  /** That other member is an Agent, so the address may need `~agent` (`agentPeerSuffix`). */
  agentPeer: boolean;
  unreadCount: number;
  globalRank: number;
  /** The Agent is not in the channel: it was notified of this one message by the sender. */
  nonMemberMention: boolean;
};

/**
 * What the raw recovery statement cannot join, read for its rows in two more queries: the
 * mention rows (so embedded tokens read as plain `@handle` text, which is all an Agent ever
 * reads) and the Memory Hints delivered to the Agent.
 */
export async function recoverySecondPass(
  db: Pick<PrismaClient, "messageMention" | "memoryHintRecord">,
  workspaceId: string,
  agentId: string,
  rows: readonly Pick<AgentRecoveryRow, "id">[],
) {
  const ids = rows.map((row) => row.id);
  const [mentionRows, hints] = rows.length
    ? await Promise.all([
        db.messageMention.findMany({
          where: { messageId: { in: ids } },
          select: { messageId: true, kind: true, actorId: true, handle: true },
        }),
        db.memoryHintRecord.findMany({
          where: {
            workspaceId,
            targetAgentId: agentId,
            deliveredAt: { not: null },
            messageId: { in: ids },
          },
          select: { id: true, messageId: true },
        }),
      ])
    : [[], []];
  const mentionsByMessage = new Map<string, { kind: string; actorId: string; handle: string }[]>();
  for (const mention of mentionRows) {
    const list = mentionsByMessage.get(mention.messageId) ?? [];
    list.push(mention);
    mentionsByMessage.set(mention.messageId, list);
  }
  return {
    mentionsByMessage,
    hintsByMessage: new Map(hints.map((hint) => [hint.messageId, hint.id])),
  };
}
