import type {
  AgentSearchResponse,
  AgentSendDecisionResponse,
  AgentSendCommittedResponse,
  AgentResolveResponse,
  AgentReactionResponse,
} from "@lrm/coforge-sdk/agent";
import type { AgentMessageTransportResponse } from "./agent-http-clients";

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
