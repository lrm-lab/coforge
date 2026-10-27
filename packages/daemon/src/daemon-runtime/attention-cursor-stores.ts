import { AgentAttentionDecisionStore } from "#src/persistence/agent-attention-decision-store";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";

/** Durable attention cursors composed into the message index: what was consumed, and the decision journal. */
export function attentionCursorStores() {
  return {
    consumedSeqs: new AgentConsumedSeqStore(),
    attentionDecisions: new AgentAttentionDecisionStore(),
  };
}
