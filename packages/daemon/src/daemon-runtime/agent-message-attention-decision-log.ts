import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { containsSorted } from "./agent-message-attention-index-helpers";
import { frontierSourceOf } from "./agent-message-attention-frontier-source";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/** What the daemon decided for one delivery (`agent.message.attention_decision`). */
export type AttentionDecisionOutcome = "notified" | "held" | "consumed" | "already_notified";

/** The identity fields one decision needs: a live delivery carries them all, a recovery
 * message gains `workspaceId`/`agentId` from its caller. */
export type AttentionDecisionMessage = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  messageId: string;
  conversationId?: string;
  target?: string;
  sequence: number;
  mentionDelivery?: AgentMessageDelivery["mentionDelivery"];
};

/** The one per-target consumed cursor a decision reads: its frontier, its exact sequences, and the
 * conversation it counts in (the index's own record, read here and never written). */
export type AttentionDecisionState = {
  targets: Map<string, { seq?: number; exactSeqs?: readonly number[]; conversationId?: string }>;
};

/**
 * Logs what the daemon decided for one delivery: whether it notified the Agent's session now,
 * held it for a later notice, found it already consumed (with the frontier that covered it), or
 * found its notice already given. Without this line every outcome looks the same in the log,
 * because `agent.message.delivery_indexed` is written after the decision either way. The two
 * conversation ids and the frontier's source are there to explain a decision after the fact: a
 * cursor that counts another conversation, or one moved by a read rather than by a notice, is the
 * difference between a real replay and a phantom one (task #4).
 */
export function logAttentionDecision(
  message: AttentionDecisionMessage,
  outcome: AttentionDecisionOutcome,
  state: AttentionDecisionState | undefined,
  target: string,
): void {
  const entry = state?.targets.get(target);
  logger.info("Agent delivery attention decided", {
    event: "agent.message.attention_decision",
    workspace_id: message.workspaceId,
    agent_id: message.agentId,
    delivery_id: message.deliveryId,
    message_id: message.messageId,
    target,
    sequence: message.sequence,
    conversation_id: message.conversationId ?? "",
    bound_conversation_id: entry?.conversationId ?? "",
    tracked_mention: message.mentionDelivery !== undefined,
    outcome,
    model_seen_seq: entry?.seq ?? 0,
    frontier_source: frontierSourceOf(entry),
    exact_seen: containsSorted(entry?.exactSeqs, message.sequence),
  });
}
