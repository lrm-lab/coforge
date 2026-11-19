import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { printableSender } from "./agent-notice-sender";
import { attentionFlags, latestCreatedAtField } from "./message-attention-fields";
import type { MessageAttention } from "./agent-message-attention-index";
import {
  PENDING_WINDOW_LIMIT,
  type PendingWindowEntry,
} from "./agent-message-attention-index-helpers";
import type { PreviewSeen } from "./inbox-preview-rows";

export type PendingAttentionState = {
  attention: Map<string, Map<string, MessageAttention>>;
  pendingSequences: Map<string, Map<string, Set<number>>>;
  pendingWindow: Map<string, Map<string, PendingWindowEntry[]>>;
  previewSeen: PreviewSeen;
};

export class PendingAttention {
  readonly #state: PendingAttentionState;

  constructor(state: PendingAttentionState) {
    this.#state = state;
  }

  record(
    message: AgentMessageDelivery & {
      target: string;
    },
  ): MessageAttention {
    const target = message.target;
    const latestSender = printableSender(message.latestSenderKind, message.latestSenderHandle);
    const byTarget =
      this.#state.attention.get(message.agentId) ?? new Map<string, MessageAttention>();
    const previous = byTarget.get(target);
    const pendingByTarget =
      this.#state.pendingSequences.get(message.agentId) ?? new Map<string, Set<number>>();
    const pending = pendingByTarget.get(target) ?? new Set<number>();
    pending.add(message.sequence);
    pendingByTarget.set(target, pending);
    this.#state.pendingSequences.set(message.agentId, pendingByTarget);
    const current: MessageAttention = {
      target,
      pendingCount: (previous?.pendingCount ?? 0) + 1,
      firstPendingSequence: previous?.firstPendingSequence ?? message.sequence,
      latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
      ...latestCreatedAtField(previous, message.createdAtMs),
      ...(latestSender
        ? { latestSenderKind: latestSender.kind, latestSenderHandle: latestSender.handle }
        : {}),
      flags: attentionFlags(target, message.nonMemberMention, previous),
    };
    byTarget.set(target, current);
    this.#state.attention.set(message.agentId, byTarget);
    return current;
  }
  recordWindow(agentId: string, target: string, delivery: AgentMessageDelivery): void {
    const byTarget =
      this.#state.pendingWindow.get(agentId) ?? new Map<string, PendingWindowEntry[]>();
    const entries = byTarget.get(target) ?? [];
    entries.push({ delivery, receivedAt: Date.now() });
    if (entries.length > PENDING_WINDOW_LIMIT)
      entries.splice(0, entries.length - PENDING_WINDOW_LIMIT);
    byTarget.set(target, entries);
    this.#state.pendingWindow.set(agentId, byTarget);
  }
  settle(
    agentId: string,
    target: string,
    settled: (sequence: number) => boolean,
    clear: (agentId: string, target: string) => void,
  ): void {
    const pending = this.#state.pendingSequences.get(agentId)?.get(target);
    if (pending) for (const sequence of pending) if (settled(sequence)) pending.delete(sequence);
    const byTarget = this.#state.pendingWindow.get(agentId);
    const entries = byTarget?.get(target);
    if (byTarget && entries) {
      const kept = entries.filter((entry) => !settled(entry.delivery.sequence));
      if (kept.length === 0) byTarget.delete(target);
      else if (kept.length !== entries.length) byTarget.set(target, kept);
    }
    const attention = this.#state.attention.get(agentId)?.get(target);
    if (!attention) return;
    if (!pending || pending.size === 0) {
      clear(agentId, target);
      return;
    }
    if (pending.size === attention.pendingCount) return;
    let first = Infinity;
    for (const sequence of pending) if (sequence < first) first = sequence;
    this.#state.attention.get(agentId)?.set(target, {
      ...attention,
      pendingCount: pending.size,
      firstPendingSequence: first,
    });
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
