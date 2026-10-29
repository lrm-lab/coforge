import type { MessageSenderKind, MessageTaskMetadata } from "@lrm/coforge-sdk/internal";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";
import type { noteAgentDmLimit } from "#src/server/conversations/agent-dm-limits.server";
import type { PendingMentionActionView } from "#src/server/conversations/pending-mention-actions.server";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import type {
  AgentMessageSearchOptions,
  AgentMessageSearchPage,
} from "./agent-message-search.repositories.server";
import type { TrackedMentionState } from "./mention-delivery.repositories.server";

/** The three Agent-visible sender facts, shared by every Agent-facing message shape. */
export type AgentFacingSender = {
  senderKind: MessageSenderKind;
  senderHandle: string;
  senderDescription: string;
};

/** Signed previews belong only to browser messages; Agents use their authenticated proxy route. */
export type AttachmentMetadata = AttachmentView;

export type DirectConversationPage = {
  messages: ({
    id: string;
    sequence: number;
    body: string;
    createdAt: Date;
    target: string;
    /** Always present, possibly empty; order matches send/upload order. */
    attachments: AttachmentMetadata[];
    task?: MessageTaskMetadata;
  } & AgentFacingSender)[];
  hasOlder: boolean;
  hasNewer: boolean;
};

export type DirectConversationPageOptions = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  fromSequence?: number;
  throughSequence?: number;
  /** Reads from the Agent's read position and reports where it stood and where it moved. */
  unread?: boolean;
};

/** The `latestSender`-prefixed sibling of `AgentFacingSender`: the same three facts, attached to
 * a target's attention summary or delivery envelope rather than a specific message's own sender.
 * Exported so `message-request-idempotency.server.ts` and `direct-message.server.ts` share this
 * one field set instead of restating it. */
export type LatestSenderFields = {
  latestSenderKind: MessageSenderKind;
  latestSenderHandle: string;
  latestSenderDescription: string;
};

export type AgentMentionBinding = { type: "user" | "agent"; id: string; name: string };

export type AgentRecoveryContext = {
  resumeMessages: Array<
    {
      messageId: string;
      deliveryId: string;
      conversationId: string;
      sequence: number;
      createdAtMs: number;
      target: string;
      body: string;
      memoryHint?: import("@lrm/coforge-sdk/agent").MemoryHintDelivery;
      /** The Agent was notified of this channel message without being a member of the channel. */
      nonMemberMention?: boolean;
    } & LatestSenderFields
  >;
  unreadSummary: Readonly<Record<string, number>>;
  unreadConversationIds?: Readonly<Record<string, string>>;
};

export type PendingAgentDelivery = AgentRecoveryContext["resumeMessages"][number] & {
  mentionsAgent?: boolean;
};

/** What an Agent's message did not reach: see `agentMentionReport`. */
export type AgentMentionReport = {
  pendingMentionActions: PendingMentionActionView[];
  unresolvedMentionHandles: string[];
};

/** Which slice of a conversation's top-level history to read: before or after a sequence. */
export type HistoryWindow = { beforeSequence?: number; afterSequence?: number; limit?: number };

export type DirectConversationRepository = {
  userIdForUsername?(target: string): Promise<string>;
  noteAgentDmLimit?(input: Parameters<typeof noteAgentDmLimit>[1]): Promise<void>;
  openAgentDirect?(
    workspaceId: string,
    agentId: string,
    parentTarget: string,
  ): Promise<{
    conversation: { id: string };
    peer: { kind: "user"; userId: string } | { kind: "agent"; agentId: string };
  }>;
  getAgentChannel?(workspaceId: string, agentId: string, target: string): Promise<{ id: string }>;
  /** The send path's channel: the Agent's channel, or one it can still join on the way to
   * posting (`needsJoin`). */
  getAgentSendChannel?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{ id: string; channelName?: string | null; needsJoin: boolean }>;
  resolveAgentTarget?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{
    conversationId: string;
    threadRootId: string | null;
    canonicalTarget: string;
    isChannel: boolean;
  }>;
  setAgentThreadFollowed?(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
  ): Promise<{ followed: boolean }>;
  getOrCreateUserAgent(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{ id: string }>;
  sendMessage(
    conversationId: string,
    senderMemberId: string,
    senderUserId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    withinSend?: SentMessageHook,
  ): Promise<
    {
      id: string;
      body: string;
      createdAt: Date;
      sequence: number;
      /** The message's thread anchor, or null for a top-level message. */
      threadRootId: string | null;
      deliveryId?: string;
      workspaceId: string;
      agentId: string;
      computerId?: string;
      /** The Agent is an app's bot: it has no Computer, and its app reads its inbox. */
      appBot?: boolean;
      target?: string;
      deliveryTarget?: string;
      /** Always present, possibly empty; order matches send order. */
      attachments: AttachmentMetadata[];
    } & Partial<LatestSenderFields>
  >;
  receiveDeliveryAck?(input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    deliveryId?: string;
    messageId: string;
    sequence: number;
  }): Promise<TrackedMentionState>;
  readMessages?(
    workspaceId: string,
    agentId: string,
    target: string,
    page?: DirectConversationPageOptions,
  ): Promise<
    ({
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender)[]
  >;
  readMessagesPage?(
    workspaceId: string,
    agentId: string,
    target: string,
    page?: DirectConversationPageOptions,
  ): Promise<DirectConversationPage>;
  searchMessages?(
    workspaceId: string,
    agentId: string,
    options: AgentMessageSearchOptions,
  ): Promise<AgentMessageSearchPage>;
  resolveAgentMessage?(
    workspaceId: string,
    agentId: string,
    anchor: string,
  ): Promise<
    {
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender
  >;
  setAgentMessageReaction?(
    workspaceId: string,
    agentId: string,
    anchor: string,
    emoji: string,
    active: boolean,
  ): Promise<{ messageId: string }>;
  readAgentRecoveryContext?(workspaceId: string, agentId: string): Promise<AgentRecoveryContext>;
  drainAgentEvents?(
    workspaceId: string,
    agentId: string,
    limit?: number,
    target?: string,
  ): Promise<{
    messages: ({
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender)[];
    hasMore: boolean;
  }>;
  readPendingAgentDeliveries?(
    workspaceId: string,
    agentId: string,
  ): Promise<PendingAgentDelivery[]>;
  advanceAgentReadThrough?(
    workspaceId: string,
    agentId: string,
    target: string,
    seenUpToSequence: number,
  ): Promise<number>;
  agentMentionReport?(
    workspaceId: string,
    agentId: string,
    message: { id: string; conversationId: string; body: string },
  ): Promise<AgentMentionReport>;
  sendAgentMessage?(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    mentions?: readonly AgentMentionBinding[],
    memoryHintId?: string,
    /** A channel send may join the channel first, in this send's transaction. */
    joinChannel?: boolean,
  ): Promise<
    {
      id: string;
      body: string;
      createdAt: Date;
      sequence: number;
      /** The message's thread anchor, or null for a top-level message. */
      threadRootId: string | null;
      deliveryId?: string;
      workspaceId: string;
      agentId: string;
      /** Present when this send joined the channel it posted to, as `#name`. */
      joinedChannel?: string;
      target: string;
      /** Attention rows created for other Agents @mentioned in a channel message (never the sender). */
      deliveries?: { deliveryId: string; agentId: string; computerId: string | null }[];
      /** Resolved mention rows (empty for DMs); translates the body's embedded mention tokens. */
      mentions?: { kind: string; actorId: string; handle: string }[];
      /** Always present, possibly empty; order matches send order. */
      attachments: AttachmentMetadata[];
      // The sending Agent's identity, for delivery envelopes.
    } & Partial<LatestSenderFields>
  >;
};
