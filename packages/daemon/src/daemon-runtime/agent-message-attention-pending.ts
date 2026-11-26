import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { printableSender } from "./agent-notice-sender";
import { attentionFlags, latestCreatedAtField } from "./message-attention-fields";
import type { MessageAttention } from "./agent-message-attention-index";
import {
  PENDING_WINDOW_LIMIT,
  type PendingWindowEntry,
} from "./agent-message-attention-index-helpers";
import type { PreviewSeen } from "./inbox-preview-rows";

export type PendingSequences = Map<string, Map<string, Map<string, Set<number>>>>;

export type PendingAttentionState = {
  attention: Map<string, Map<string, MessageAttention>>;
  pendingSequences: PendingSequences;
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
    this.rememberSequence(message.agentId, target, message.conversationId, message.sequence);
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
  rememberSequence(
    agentId: string,
    target: string,
    conversationId: string,
    sequence: number,
  ): void {
    const byTarget =
      this.#state.pendingSequences.get(agentId) ?? new Map<string, Map<string, Set<number>>>();
    const byConversation = byTarget.get(target) ?? new Map<string, Set<number>>();
    const pending = byConversation.get(conversationId) ?? new Set<number>();
    pending.add(sequence);
    byConversation.set(conversationId, pending);
    byTarget.set(target, byConversation);
    this.#state.pendingSequences.set(agentId, byTarget);
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
    conversationId: string | undefined,
    settled: (sequence: number) => boolean,
    clear: (agentId: string, target: string) => void,
  ): void {
    if (conversationId === undefined) return;
    const byConversation = this.#state.pendingSequences.get(agentId)?.get(target);
    const pending = byConversation?.get(conversationId);
    if (!pending) return;
    for (const sequence of pending) if (settled(sequence)) pending.delete(sequence);
    if (pending.size === 0) byConversation?.delete(conversationId);
    const byTarget = this.#state.pendingWindow.get(agentId);
    const entries = byTarget?.get(target);
    if (entries) {
      const kept = entries.filter(
        ({ delivery }) => delivery.conversationId !== conversationId || !settled(delivery.sequence),
      );
      if (kept.length === 0) byTarget?.delete(target);
      else if (kept.length !== entries.length) byTarget?.set(target, kept);
    }
    const attention = this.#state.attention.get(agentId)?.get(target);
    if (!attention) return;
    if (byConversation?.size === 0) {
      clear(agentId, target);
      return;
    }
    let pendingCount = 0;
    let first = Infinity;
    let latest = 0;
    for (const sequences of byConversation?.values() ?? []) {
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
    for (const target of this.#state.pendingSequences.get(agentId)?.keys() ?? []) {
      const count = this.pendingMessageCount(agentId, target);
      if (count) unread.push({ target, count });
    }
    return unread;
  }

  pendingConversationId(agentId: string, target: string): string | undefined {
    const conversations = this.#state.pendingSequences.get(agentId)?.get(target);
    return conversations?.size === 1 ? conversations.keys().next().value : undefined;
  }

  pendingMessageCount(agentId: string, target: string): number {
    let count = 0;
    const byConversation = this.#state.pendingSequences.get(agentId)?.get(target);
    for (const [conversationId, pending] of byConversation ?? []) {
      count += pending.size;
      const previewed = this.#state.previewSeen.recorded(agentId, target, conversationId);
      for (const sequence of previewed ?? []) if (pending.has(sequence)) count--;
    }
    return count;
  }

  pendingMaxSequence(agentId: string, target: string): number {
    let max = 0;
    const byConversation = this.#state.pendingSequences.get(agentId)?.get(target);
    for (const [conversationId, pending] of byConversation ?? []) {
      const previewed = this.#state.previewSeen.recorded(agentId, target, conversationId);
      for (const sequence of pending)
        if (sequence > max && !previewed?.has(sequence)) max = sequence;
    }
    return max;
  }

  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    const entries = this.#state.pendingWindow.get(agentId)?.get(target) ?? [];
    return entries
      .filter(
        ({ delivery }) =>
          !this.#state.previewSeen.has(agentId, target, delivery.sequence, delivery.conversationId),
      )
      .slice(-limit);
  }
}
