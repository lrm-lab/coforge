import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { printableSender } from "./agent-notice-sender";
import { attentionFlags, latestCreatedAtField } from "./message-attention-fields";
import {
  containsSorted,
  PENDING_WINDOW_LIMIT,
  type MessageAttention,
  type PendingWindowEntry,
} from "./agent-message-attention-index-helpers";

type PendingTarget = {
  byConversation: Map<string, Set<number>>;
  window: PendingWindowEntry[];
};

type PendingAttentionState = {
  attention: Map<string, Map<string, MessageAttention>>;
  fullPreviewSequences(
    agentId: string,
    target: string,
    conversationId: string,
  ): readonly number[] | undefined;
};

export class PendingAttention {
  readonly #state: PendingAttentionState;
  readonly #deliveries = new Map<string, Map<string, PendingTarget>>();

  constructor(state: PendingAttentionState) {
    this.#state = state;
  }

  record(
    message: AgentMessageDelivery & {
      target: string;
    },
  ): void {
    const target = message.target;
    const latestSender = printableSender(message.latestSenderKind, message.latestSenderHandle);
    const byTarget =
      this.#state.attention.get(message.agentId) ?? new Map<string, MessageAttention>();
    const previous = byTarget.get(target);
    const pending = this.#target(message.agentId, target);
    this.rememberSequence(message.agentId, target, message.conversationId, message.sequence);
    pending.window.push({ delivery: message, receivedAt: Date.now() });
    if (pending.window.length > PENDING_WINDOW_LIMIT) pending.window.shift();
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
  }
  rememberSequence(
    agentId: string,
    target: string,
    conversationId: string,
    sequence: number,
  ): void {
    const { byConversation } = this.#target(agentId, target);
    const pending = byConversation.get(conversationId) ?? new Set<number>();
    pending.add(sequence);
    byConversation.set(conversationId, pending);
  }

  #target(agentId: string, target: string): PendingTarget {
    let byTarget = this.#deliveries.get(agentId);
    if (!byTarget) this.#deliveries.set(agentId, (byTarget = new Map()));
    let pending = byTarget.get(target);
    if (!pending) {
      pending = { byConversation: new Map(), window: [] };
      byTarget.set(target, pending);
    }
    return pending;
  }

  clearAgent(agentId: string): void {
    this.#deliveries.delete(agentId);
  }

  clear(agentId: string, target: string): void {
    const byTarget = this.#deliveries.get(agentId);
    byTarget?.delete(target);
    if (byTarget?.size === 0) this.#deliveries.delete(agentId);
  }

  targets(agentId: string): Iterable<string> {
    return this.#deliveries.get(agentId)?.keys() ?? [];
  }

  settle(
    agentId: string,
    target: string,
    conversationId: string | undefined,
    settled: (sequence: number) => boolean,
    clear: (agentId: string, target: string) => void,
  ): void {
    if (conversationId === undefined) return;
    const deliveryTarget = this.#deliveries.get(agentId)?.get(target);
    const pending = deliveryTarget?.byConversation.get(conversationId);
    if (!deliveryTarget || !pending) return;
    const { byConversation } = deliveryTarget;
    for (const sequence of pending) if (settled(sequence)) pending.delete(sequence);
    if (pending.size === 0) byConversation.delete(conversationId);
    if (deliveryTarget.window.length) {
      deliveryTarget.window = deliveryTarget.window.filter(
        ({ delivery }) => delivery.conversationId !== conversationId || !settled(delivery.sequence),
      );
    }
    const attention = this.#state.attention.get(agentId)?.get(target);
    if (!attention) return;
    if (byConversation.size === 0) {
      clear(agentId, target);
      return;
    }
    let pendingCount = 0;
    let first = Infinity;
    let latest = 0;
    for (const sequences of byConversation.values()) {
      pendingCount += sequences.size;
      for (const sequence of sequences) {
        first = Math.min(first, sequence);
        latest = Math.max(latest, sequence);
      }
    }
    if (pendingCount === attention.pendingCount) return;
    this.#state.attention.get(agentId)?.set(target, {
      ...attention,
      pendingCount,
      firstPendingSequence: first,
      latestSequence: latest,
    });
  }

  unreadDeliveries(agentId: string): { target: string; count: number }[] {
    const unread: { target: string; count: number }[] = [];
    for (const target of this.targets(agentId)) {
      const count = this.pendingMessageCount(agentId, target);
      if (count) unread.push({ target, count });
    }
    return unread;
  }

  pendingConversationId(agentId: string, target: string): string | undefined {
    const conversations = this.#deliveries.get(agentId)?.get(target)?.byConversation;
    return conversations?.size === 1 ? conversations.keys().next().value : undefined;
  }

  pendingMessageCount(agentId: string, target: string): number {
    let count = 0;
    const byConversation = this.#deliveries.get(agentId)?.get(target)?.byConversation;
    for (const [conversationId, pending] of byConversation ?? []) {
      count += pending.size;
      const previewed = this.#state.fullPreviewSequences(agentId, target, conversationId);
      for (const sequence of previewed ?? []) if (pending.has(sequence)) count--;
    }
    return count;
  }

  pendingMaxSequence(agentId: string, target: string): number {
    let max = 0;
    const byConversation = this.#deliveries.get(agentId)?.get(target)?.byConversation;
    for (const [conversationId, pending] of byConversation ?? []) {
      const previewed = this.#state.fullPreviewSequences(agentId, target, conversationId);
      for (const sequence of pending)
        if (sequence > max && !containsSorted(previewed, sequence)) max = sequence;
    }
    return max;
  }

  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    const entries = this.#deliveries.get(agentId)?.get(target)?.window ?? [];
    return entries
      .filter(
        ({ delivery }) =>
          !containsSorted(
            this.#state.fullPreviewSequences(agentId, target, delivery.conversationId),
            delivery.sequence,
          ),
      )
      .slice(-limit);
  }
}
