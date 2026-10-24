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
  deliveryId: string | null;
  senderAgentName: string | null;
  senderAgentDescription: string | null;
  senderUsername: string | null;
  senderUserDescription: string | null;
  channelName: string | null;
  /** The conversation's other active member: the address a DM reply targets. */
  otherUsername: string | null;
  unreadCount: number;
  globalRank: number;
  /** The Agent is not in the channel: it was notified of this one message by the sender. */
  nonMemberMention: boolean;
};
