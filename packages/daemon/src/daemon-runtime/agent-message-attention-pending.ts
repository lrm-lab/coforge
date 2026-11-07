import type { MessageAttention } from "./agent-message-attention-index";
import type { PendingWindowEntry } from "./agent-message-attention-index-helpers";
import type { PreviewSeen } from "./inbox-preview-rows";

/** The per-Agent maps the pending-attention reads consult, shared by reference with
 * `AgentMessageAttentionIndex`, which stays their only writer. */
export type PendingAttentionState = {
  attention: ReadonlyMap<string, ReadonlyMap<string, MessageAttention>>;
  pendingSequences: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  observedSequences: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  pendingWindow: ReadonlyMap<string, ReadonlyMap<string, readonly PendingWindowEntry[]>>;
  previewSeen: PreviewSeen;
};

/**
 * The pending-attention reads of `AgentMessageAttentionIndex`: what still waits unread for an
 * Agent, per target — the counts, the newest sequence and the bounded window a locally decided
 * freshness hold presents. The index owns every write; this reader holds the same maps so the
 * reads live in one module.
 */
export class PendingAttentionReads {
  readonly #state: PendingAttentionState;

  constructor(state: PendingAttentionState) {
    this.#state = state;
  }

  /** How many messages delivered to the Agent wait unread, per target: pending attention without a
   * Memory Agent's observed channel updates, which wait for its own batched read, not for it, and
   * without the sequences a notice already showed in full. `previewSeen` is volatile, so a new
   * context counts those sequences unread again. */
  unreadDeliveries(agentId: string): { target: string; count: number }[] {
    const observed = this.#state.observedSequences.get(agentId);
    const unread: { target: string; count: number }[] = [];
    for (const [target, pending] of this.#state.pendingSequences.get(agentId) ?? []) {
      const previewed = this.#state.previewSeen.recorded(agentId, target);
      let count = 0;
      for (const sequence of pending)
        if (!observed?.get(target)?.has(sequence) && !previewed?.has(sequence)) count++;
      if (count) unread.push({ target, count });
    }
    return unread;
  }

  /** Messages the Agent has not been shown yet for this exact target, less the sequences a notice
   * previewed in full: shown once is enough for the send gate, and `previewSeen` being volatile
   * still restores them as pending on a new context. A target with no attention entry has none:
   * entries are created by a delivery and cleared once the boundary catches up. */
  pendingMessageCount(agentId: string, target: string): number {
    const attention = this.#state.attention.get(agentId)?.get(target);
    if (!attention) return 0;
    const previewed = this.#state.previewSeen.recorded(agentId, target);
    if (!previewed?.size) return attention.pendingCount;
    const pending = this.#state.pendingSequences.get(agentId)?.get(target);
    let shown = 0;
    for (const sequence of previewed) if (pending?.has(sequence)) shown++;
    return Math.max(0, attention.pendingCount - shown);
  }

  /** The newest message the Agent has not been shown for this exact target, or 0: what a locally
   * held send presents as its `seenUpToSeq` (the held boundary is the unconsumed maximum). A
   * previewed sequence does not count, same as in `pendingMessageCount`. */
  pendingMaxSequence(agentId: string, target: string): number {
    const previewed = this.#state.previewSeen.recorded(agentId, target);
    let max = 0;
    for (const sequence of this.#state.pendingSequences.get(agentId)?.get(target) ?? [])
      if (sequence > max && !previewed?.has(sequence)) max = sequence;
    return max;
  }

  /** The newest unreviewed deliveries for `target`, oldest first, at most `limit` of them: the
   * window a locally decided hold presents. Sequences a notice already showed in full are left
   * out, so a hold never re-presents what the Agent has seen. */
  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    const previewed = this.#state.previewSeen.recorded(agentId, target);
    const entries = this.#state.pendingWindow.get(agentId)?.get(target) ?? [];
    if (!previewed?.size) return entries.slice(-limit);
    return entries.filter((entry) => !previewed.has(entry.delivery.sequence)).slice(-limit);
  }
}
