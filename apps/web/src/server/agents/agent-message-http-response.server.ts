import type { AgentMessage, AgentSendDecisionResponse } from "@lrm/coforge-sdk/agent";
import type { AgentSendMessageResult } from "./agent-messages.server";

/** Maps `executeAgentSendMessageWithPolicy`'s side-effect decision onto the send route's response,
 * using the field names of `agentApiSendResponseSchema` for both states. */
export function mapSendResult(idempotencyKey: string, result: AgentSendMessageResult) {
  const toAgentMessage = (message: { createdAt: Date }) =>
    ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    }) as AgentMessage;
  const response: AgentSendDecisionResponse = {
    idempotencyKey,
    state: result.state,
    decision: result.decision,
    reason: result.reason,
    producerFactId: result.producerFactId,
    messageId: result.messageId,
    availableActions: result.availableActions ? [...result.availableActions] : undefined,
    continueAnywaySuggested: result.continueAnywaySuggested,
    // Held-context fields are only ever present on a held result; a sent one carries none.
    heldMessages:
      result.state === "held" ? (result.heldMessages ?? []).map(toAgentMessage) : undefined,
    newMessageCount: result.newMessageCount,
    shownMessageCount: result.shownMessageCount,
    omittedMessageCount: result.omittedMessageCount,
    // Held: the boundary the notice presented. Sent: the boundary the send advanced over messages
    // the Agent had already seen, when it advanced one.
    seenUpToSeq: result.seenUpToSeq,
    freshnessContextMode: result.freshnessContextMode,
    withheldMessageCount: result.withheldMessageCount,
    recentUnread: (result.recentUnread ?? []).map(toAgentMessage),
    // Sent only: what the message did not reach.
    pendingMentionActions:
      result.state === "sent"
        ? (result.pendingMentionActions ?? []).map((action) => ({
            resolutionId: action.resolutionId,
            messageId: action.messageId,
            targetType: action.targetType,
            targetHandle: action.targetHandle,
            targetAvatarUrl: action.targetAvatarUrl,
            reason: "not_member" as const,
            availableActions: [...action.availableActions],
            expiresAt: action.expiresAt.toISOString(),
          }))
        : undefined,
    unresolvedMentionHandles:
      result.state === "sent" ? [...(result.unresolvedMentionHandles ?? [])] : undefined,
  };
  return response;
}
