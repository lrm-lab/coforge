import { diagnosticErrorName, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  consumedReadBasis,
  containsSorted,
  type ConsumedReadBasis,
} from "./agent-message-attention-index-helpers";
import type { NoticeGeneration } from "./agent-wakeup-unavailable-error";
import { frontierSourceOf } from "./agent-message-attention-frontier-source";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type AttentionDecisionOutcome =
  | "notified"
  | "held"
  | "consumed"
  | "already_notified"
  | "already_recorded"
  | "notification_in_flight";

export function recordedDeliveryOutcome(
  generation: Pick<
    NoticeGeneration,
    "acceptedDeliveryIds" | "recordedHeld" | "notificationAttempts"
  >,
  deliveryId: string,
): AttentionDecisionOutcome {
  if (generation.acceptedDeliveryIds.has(deliveryId)) return "already_notified";
  if (generation.notificationAttempts.has(deliveryId)) return "notification_in_flight";
  if (generation.recordedHeld.has(deliveryId)) return "held";
  return "already_recorded";
}

export type AttentionReadBasis = ConsumedReadBasis | "full_preview";
export type AttentionDecisionBasis =
  | AttentionReadBasis
  | "accepted_message"
  | "delivery_generation";

export type AttentionDecisionMessage = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  requestId?: string;
  messageId: string;
  conversationId?: string;
  target?: string;
  sequence: number;
  mentionDelivery?: AgentMessageDelivery["mentionDelivery"];
};

export function logAttentionDecision(
  message: AttentionDecisionMessage,
  outcome: AttentionDecisionOutcome,
  entry: { seq?: number; exactSeqs?: readonly number[]; conversationId?: string } | undefined,
  target: string,
  basis?: AttentionDecisionBasis,
): void {
  if (basis === undefined) {
    if (outcome === "already_notified") basis = "delivery_generation";
    if (outcome === "consumed" && entry?.conversationId === message.conversationId)
      basis = consumedReadBasis(entry, message.sequence);
  }
  logger.info("Agent delivery attention decided", {
    event: "agent.message.attention_decision",
    workspace_id: message.workspaceId,
    agent_id: message.agentId,
    daemon_pid: process.pid,
    request_id: message.requestId,
    delivery_id: message.deliveryId,
    message_id: message.messageId,
    target,
    sequence: message.sequence,
    conversation_id: message.conversationId ?? "",
    bound_conversation_id: entry?.conversationId ?? "",
    tracked_mention: message.mentionDelivery !== undefined,
    outcome,
    decision_basis: basis,
    model_seen_seq: entry?.seq ?? 0,
    frontier_source: frontierSourceOf(entry),
    exact_seen: containsSorted(entry?.exactSeqs, message.sequence),
  });
}

export function logRecoveryNoticeAccepted(
  workspaceId: string,
  agentId: string,
  counts: { recoveredMessageCount: number; summaryUnreadCount: number },
): void {
  logger.info("Agent accepted recovery notice", {
    event: "agent.message.recovery_notice_accepted",
    workspace_id: workspaceId,
    agent_id: agentId,
    daemon_pid: process.pid,
    recovered_message_count: counts.recoveredMessageCount,
    summary_unread_count: counts.summaryUnreadCount,
  });
}

export function logCustodyAckFailure(message: AgentMessageDelivery, error: unknown): void {
  logger.warn("Agent delivery could not be acknowledged on taking it", {
    event: "agent.message.custody_ack_failed",
    agent_id: message.agentId,
    delivery_id: message.deliveryId,
    error_code: diagnosticErrorName(error),
  });
}
