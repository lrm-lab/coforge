import type { LocalSearchPaging } from "@lrm/coforge-sdk/internal";
import type {
  AgentHistoryConsumptionScope,
  AgentMessage,
  AgentSearchResponse,
  AgentSendDecisionResponse,
  AgentSendCommittedResponse,
  AgentResolveResponse,
  AgentReactionResponse,
} from "@lrm/coforge-sdk/agent";

export type AgentMessageTransportResponse = LocalSearchPaging & {
  idempotencyKey: string;
  accepted: boolean;
  attentionCount: number;
  messageId?: string;
  messages: AgentMessage[];
  /** `send` only: the send contract (state/decision/reason/counts); `committed` is a send whose
   * lost answer reconciliation confirmed. */
  state?: AgentSendDecisionResponse["state"] | AgentSendCommittedResponse["state"];
  decision?: AgentSendDecisionResponse["decision"];
  reason?: string;
  producerFactId?: string;
  availableActions?: string[];
  continueAnywaySuggested?: boolean;
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  hasOlder?: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
  /** `read` only: the server's contiguous model-seen boundary (`model_seen_up_to_seq`); `null`
   * when the page does not join what the Agent had read. */
  modelSeenUpToSeq?: number | null;
  unreadCursorBefore?: number;
  readPositionAfter?: number;
  moreUnread?: boolean;
  /** `read` only: the conversation the read consumed (`consumption_scope`). */
  consumptionScope?: AgentHistoryConsumptionScope;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** `send` only: `seenUpToSeq` — on a held response, the frontier the notice presented; on a
   * sent one, the boundary the server advanced over messages the Agent had already seen. Either
   * is what the daemon records as consumed. */
  seenUpToSeq?: number;
  /** `send` only: pending messages a bypassed hold chose not to review; empty otherwise. */
  recentUnread?: AgentMessage[];
  /** `send` only: the mentions a sent message did not deliver, as the server reported them. */
  pendingMentionActions?: AgentSendDecisionResponse["pendingMentionActions"];
  unresolvedMentionHandles?: string[];
  /** `send` only: the channel this send joined on the way, as `#name`. */
  joinedChannel?: string;
};

/** Adapts the dedicated search route's response into the shape `DaemonRuntime` consumes. */
export function adaptAgentSearchResponse(
  response: AgentSearchResponse,
): AgentMessageTransportResponse {
  const { results, ...rest } = response;
  return { ...rest, accepted: true, attentionCount: 0, messages: results };
}

/**
 * Adapts the send route's response into the shape `DaemonRuntime` consumes. The server's
 * `state`/`decision` are carried through unchanged; `messages` is the held context window.
 */
export function adaptAgentSendResponse(
  response: AgentSendDecisionResponse,
): AgentMessageTransportResponse {
  return {
    idempotencyKey: response.idempotencyKey,
    accepted: response.state === "sent",
    attentionCount: response.heldMessages?.length ?? 0,
    messageId: response.messageId,
    messages: response.heldMessages ?? [],
    state: response.state,
    decision: response.decision,
    reason: response.reason,
    producerFactId: response.producerFactId,
    availableActions: response.availableActions,
    continueAnywaySuggested: response.continueAnywaySuggested,
    newMessageCount: response.newMessageCount,
    shownMessageCount: response.shownMessageCount,
    omittedMessageCount: response.omittedMessageCount,
    freshnessContextMode: response.freshnessContextMode,
    withheldMessageCount: response.withheldMessageCount,
    seenUpToSeq: response.seenUpToSeq,
    recentUnread: response.recentUnread,
    pendingMentionActions: response.pendingMentionActions,
    unresolvedMentionHandles: response.unresolvedMentionHandles,
    joinedChannel: response.joinedChannel,
  };
}

/** A send confirmed by reconciliation, in the shape `DaemonRuntime` consumes: accepted, with its
 * message id and no receipt (no held window, no recent unread, no mention report). */
export function adaptAgentSendCommittedResponse(
  response: AgentSendCommittedResponse,
): AgentMessageTransportResponse {
  return {
    idempotencyKey: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messageId: response.messageId,
    messages: [],
    state: "committed",
  };
}

/** Adapts the resolve route's response into the shape `DaemonRuntime` consumes. */
export function adaptAgentResolveResponse(
  response: AgentResolveResponse,
): AgentMessageTransportResponse {
  return {
    idempotencyKey: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messages: [response.message],
  };
}

/** Adapts the reaction routes' response into the shape `DaemonRuntime` consumes. */
export function adaptAgentReactionResponse(
  response: AgentReactionResponse,
): AgentMessageTransportResponse {
  return {
    idempotencyKey: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messageId: response.messageId,
    messages: [],
  };
}
