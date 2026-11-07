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
   * Memory Agent's observed channel updates, which wait for its own batched read, not for it. */
  unreadDeliveries(agentId: string): { target: string; count: number }[] {
    const observed = this.#state.observedSequences.get(agentId);
    const unread: { target: string; count: number }[] = [];
    for (const [target, pending] of this.#state.pendingSequences.get(agentId) ?? []) {
      let count = 0;
      for (const sequence of pending) if (!observed?.get(target)?.has(sequence)) count++;
      if (count) unread.push({ target, count });
    }
    return unread;
  }

  /** Messages the Agent has not been shown yet for this exact target. A target with no attention
   * entry has none: entries are created by a delivery and cleared once the boundary catches up. */
  pendingMessageCount(agentId: string, target: string): number {
    return this.#state.attention.get(agentId)?.get(target)?.pendingCount ?? 0;
  }

  /** The newest message the Agent has not been shown for this exact target, or 0: what a locally
   * held send presents as its `seenUpToSeq` (the held boundary is the unconsumed maximum). */
  pendingMaxSequence(agentId: string, target: string): number {
    let max = 0;
    for (const sequence of this.#state.pendingSequences.get(agentId)?.get(target) ?? [])
      if (sequence > max) max = sequence;
    return max;
  }

  /** The newest unreviewed deliveries for `target`, oldest first, at most `limit` of them: the
   * window a locally decided hold presents. */
  pendingWindow(
    agentId: string,
    target: string,
    limit: number,
  ): readonly PendingWindowEntry[] {
    const entries = this.#state.pendingWindow.get(agentId)?.get(target) ?? [];
    return entries.slice(-limit);
  }
}
