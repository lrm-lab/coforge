import type { AgentPendingMentionAction, MessageTaskMetadata } from "#src/internal/local-daemon";
export type { AgentPendingMentionAction };
import type { ForwardedMessage } from "#src/internal/forwarded-message";
import type { MessageSenderKind } from "#src/internal/message-sender";
export type AgentMessageOperation = "read" | "search" | "send";
export type AgentMessagesReadRequest = {
  target: string;
  unread?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
};
export type AgentMessagesSearchRequest = {
  query: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  offset?: number;
  cursor?: string;
  limit?: number;
};
export type AgentMentionSelector = {
  type: "user" | "agent";
  id: string;
  name: string;
};
export type AgentMessagesSendRequest = {
  target: string;
  body: string;
  sendDraft?: boolean;
  continueAnyway?: boolean;
  freshnessContextMode?: "inline" | "withheld";
  attachmentIds?: string[];
  mentions?: AgentMentionSelector[];
};
export type AgentMessagesResolveRequest = {
  messageId: string;
};
export type AgentEventsGetRequest = {
  limit?: number;
};
export type AgentMessagesReactionRequest = {
  messageId: string;
  emoji: string;
};
export type AgentMessage = {
  id: string;
  sequence: number;
  senderKind: MessageSenderKind;
  senderHandle: string;
  senderDescription: string;
  target: string;
  body: string;
  createdAt: string;
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }[];
  tasks?: MessageTaskMetadata[];
  forwardedMessages?: ForwardedMessage[];
  forwarded?: ForwardedMessage;
  attachmentCommentAnchor?: import("./attachment-comments").AgentAttachmentCommentAnchor;
};
export type AgentHistoryConsumptionScope = {
  agentId: string;
  conversationId: string;
  channelType: "dm" | "thread";
  target: string;
};
export type AgentHistoryResponse = {
  idempotencyKey: string;
  messages: AgentMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
  modelSeenUpToSeq: number | null;
  unreadCursorBefore?: number;
  readPositionAfter?: number;
  moreUnread?: boolean;
  consumptionScope?: AgentHistoryConsumptionScope;
};
export type AgentSearchResponse = {
  idempotencyKey: string;
  results: AgentMessage[];
  hasMore?: boolean;
  nextCursor?: string;
  incomplete?: boolean;
  searchedMessages?: number;
  searchedThrough?: string;
};
export type AgentSendResponse =
  | AgentSendDecisionResponse
  | AgentSendCommittedResponse
  | AgentSendNotFoundResponse;
export type AgentSendReconciliationResponse =
  | AgentSendCommittedResponse
  | AgentSendNotFoundResponse;
export type AgentSendCommittedResponse = {
  idempotencyKey: string;
  state: "committed";
  reconciliation: true;
  receiptComplete: false;
  messageId: string;
};
export type AgentSendNotFoundResponse = {
  idempotencyKey: string;
  state: "not_found";
  reconciliation: true;
};
export type AgentSendDecisionResponse = {
  idempotencyKey: string;
  state: "sent" | "held";
  decision: "forward" | "bypass" | "local_hold" | "syncing_hold";
  reason?: string;
  producerFactId?: string;
  messageId?: string;
  availableActions?: string[];
  continueAnywaySuggested?: boolean;
  heldMessages?: AgentMessage[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  recentUnread?: AgentMessage[];
  pendingMentionActions?: AgentPendingMentionAction[];
  unresolvedMentionHandles?: string[];
  joinedChannel?: string;
};
export type AgentResolveResponse = {
  idempotencyKey: string;
  message: AgentMessage;
};
export type AgentReactionResponse = {
  idempotencyKey: string;
  messageId: string;
  emoji: string;
  active: boolean;
};
export type AgentEventsResponse = {
  idempotencyKey: string;
  events: AgentMessage[];
  hasMore: boolean;
};
export type AgentChannelAttentionResponse = {
  idempotencyKey: string;
  target: string;
  muted: boolean;
};
export type AgentThreadAttentionResponse = {
  idempotencyKey: string;
  target: string;
  followed: boolean;
};
