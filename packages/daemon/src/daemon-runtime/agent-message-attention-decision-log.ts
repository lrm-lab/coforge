import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { containsSorted } from "./agent-message-attention-index-helpers";
import { frontierSourceOf } from "./agent-message-attention-frontier-source";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type AttentionDecisionOutcome = "notified" | "held" | "consumed" | "already_notified";

export type AttentionDedupBasis = "accepted_message" | "delivery_generation";

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

export type AttentionDecisionState = {
  targets: Map<string, { seq?: number; exactSeqs?: readonly number[]; conversationId?: string }>;
};

export function logAttentionDecision(
  message: AttentionDecisionMessage,
  outcome: AttentionDecisionOutcome,
  state: AttentionDecisionState | undefined,
  target: string,
  dedupBasis?: AttentionDedupBasis,
): void {
  const entry = state?.targets.get(target);
  const exactSeen = containsSorted(entry?.exactSeqs, message.sequence);
  let basis: AttentionDedupBasis | "read_frontier" | "exact_read" | undefined;
  if (outcome === "already_notified") basis = dedupBasis ?? "delivery_generation";
  if (outcome === "consumed" && entry?.conversationId === message.conversationId) {
    if ((entry?.seq ?? 0) >= message.sequence) basis = "read_frontier";
    else if (exactSeen) basis = "exact_read";
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
    exact_seen: exactSeen,
  });
}
