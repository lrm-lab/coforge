import type {
  AgentMessageContinuationOffer,
  AgentMessageResponse,
} from "@lrm/coforge-sdk/internal";
import type { AgentMessageTransportResponse } from "#src/connection/agent-message-adapters";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";

/** The send's answer to the Agent: the transport result carried through, with withheld context
 * blanked when the send ran under reviewer isolation. */
export function agentSendResponse(input: {
  idempotencyKey: string;
  result: AgentMessageTransportResponse;
  contextWasWithheld: boolean;
  recentUnread?: AgentMessageRecord[];
  continuation?: AgentMessageContinuationOffer;
}): AgentMessageResponse {
  const { idempotencyKey, result, contextWasWithheld, recentUnread, continuation } = input;
  return {
    idempotencyKey,
    accepted: result.accepted,
    attentionCount: result.attentionCount,
    messageId: result.messageId ?? "",
    messages: contextWasWithheld ? [] : result.messages,
    summaries: [],
    continuation,
    // An accepted same-key send whose commit predates this request replayed the stored original:
    // `messageId` names it, and nothing this request carried was delivered.
    replayedOriginal: result.reason === "already_committed" || undefined,
    // The send contract, carried to the Agent unchanged.
    state: result.state,
    decision: result.decision,
    reason: result.reason,
    producerFactId: result.producerFactId,
    availableActions: result.availableActions,
    continueAnywaySuggested: result.continueAnywaySuggested,
    newMessageCount: result.newMessageCount,
    shownMessageCount: result.shownMessageCount,
    omittedMessageCount: result.omittedMessageCount,
    freshnessContextMode: result.freshnessContextMode,
    withheldMessageCount: contextWasWithheld
      ? (result.withheldMessageCount ?? result.attentionCount)
      : undefined,
    recentUnread,
    // What a sent message did not deliver, for the Agent's `coforge mention` recovery.
    pendingMentionActions: result.pendingMentionActions,
    unresolvedMentionHandles: result.unresolvedMentionHandles,
    // The channel the send joined on the way, for the Agent's notice.
    joinedChannel: result.joinedChannel,
  };
}
