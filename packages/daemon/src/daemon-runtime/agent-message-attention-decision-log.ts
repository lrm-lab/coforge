import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { containsSorted } from "./agent-message-attention-index-helpers";

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
  target?: string;
  sequence: number;
  mentionDelivery?: AgentMessageDelivery["mentionDelivery"];
};

/**
 * Logs what the daemon decided for one delivery: whether it notified the Agent's session now,
 * held it for a later notice, found it already consumed (with the frontier that covered it), or
 * found its notice already given. Without this line every outcome looks the same in the log,
 * because `agent.message.delivery_indexed` is written after the decision either way.
 */
export function logAttentionDecision(
  message: AttentionDecisionMessage,
  outcome: AttentionDecisionOutcome,
  modelSeenSeq: number,
  exactSeqs: readonly number[] | undefined,
): void {
  logger.info("Agent delivery attention decided", {
    event: "agent.message.attention_decision",
    workspace_id: message.workspaceId,
    agent_id: message.agentId,
    delivery_id: message.deliveryId,
    message_id: message.messageId,
    target: message.target ?? "",
    sequence: message.sequence,
    tracked_mention: message.mentionDelivery !== undefined,
    outcome,
    model_seen_seq: modelSeenSeq,
    exact_seen: containsSorted(exactSeqs, message.sequence),
  });
}
