import type { MessageAttention } from "./agent-message-attention-index";
import type { PendingWindowEntry } from "./agent-message-attention-index-helpers";
import type { PreviewSeen } from "./inbox-preview-rows";

export type PendingAttentionState = {
  attention: ReadonlyMap<string, ReadonlyMap<string, MessageAttention>>;
  pendingSequences: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  pendingWindow: ReadonlyMap<string, ReadonlyMap<string, readonly PendingWindowEntry[]>>;
  previewSeen: PreviewSeen;
};

export class PendingAttentionReads {
  readonly #state: PendingAttentionState;

  constructor(state: PendingAttentionState) {
    this.#state = state;
  }

  unreadDeliveries(agentId: string): { target: string; count: number }[] {
    const unread: { target: string; count: number }[] = [];
    for (const [target, pending] of this.#state.pendingSequences.get(agentId) ?? []) {
      const previewed = this.#state.previewSeen.recorded(agentId, target);
      let count = 0;
      for (const sequence of pending) if (!previewed?.has(sequence)) count++;
      if (count) unread.push({ target, count });
    }
    return unread;
  }

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

  pendingMaxSequence(agentId: string, target: string): number {
    const previewed = this.#state.previewSeen.recorded(agentId, target);
    let max = 0;
    for (const sequence of this.#state.pendingSequences.get(agentId)?.get(target) ?? [])
      if (sequence > max && !previewed?.has(sequence)) max = sequence;
    return max;
  }

  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    const previewed = this.#state.previewSeen.recorded(agentId, target);
    const entries = this.#state.pendingWindow.get(agentId)?.get(target) ?? [];
    if (!previewed?.size) return entries.slice(-limit);
    return entries.filter((entry) => !previewed.has(entry.delivery.sequence)).slice(-limit);
  }
}
