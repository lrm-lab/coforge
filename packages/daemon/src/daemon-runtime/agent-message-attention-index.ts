import type {
  AgentMessageDelivery,
  AgentMessageDeliveryAck,
  AgentRecoveryMessage,
  MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
import type { AgentConversationScope } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { setContextViewMessageIds } from "./context-view-runtime-wiring";
import { NoticeActionClocks } from "./notice-action-clocks";
import { countDistinctMessages } from "./agent-history-read";
import { composeDeliveryNotice } from "./delivery-notice";
import { rememberDelivery } from "./delivery-generation-memory";
import {
  AGENT_MESSAGE_ACK_METHOD,
  SEEN_EXACT_SEQS_LIMIT,
  mergeSeenExactSeqs,
  threadRootTarget,
} from "@lrm/coforge-sdk/internal";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { attentionFlags, hasDeliveryScope, latestCreatedAtField } from "./message-attention-fields";
import { printableSender } from "./agent-notice-sender";
import {
  acceptNotice,
  AgentWakeupUnavailableError,
  noticeGeneration,
  type NoticeGeneration,
} from "./agent-wakeup-unavailable-error";
import { PreviewSeen } from "./inbox-preview-rows";
import { LatestThreadReadIndex } from "./latest-thread-read-index";
import {
  logAttentionDecision,
  type AttentionDecisionMessage,
  type AttentionDecisionOutcome,
} from "./agent-message-attention-decision-log";
import { noteFrontierSource, type FrontierSource } from "./agent-message-attention-frontier-source";
import { planRecovery } from "./agent-message-attention-recovery";
import type { AgentConsumedSeqPort } from "#src/persistence/agent-consumed-seq-store";
import { diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import { PendingAttentionReads } from "./agent-message-attention-pending";
import {
  PENDING_WINDOW_LIMIT,
  attentionRecorded,
  consumedSnapshot,
  byNumber,
  containsSorted,
  firstAbove,
  isAscending,
  isCardEvent,
  markFlushed,
  markNotified,
  sameThreadRoot,
  type ConsumedAgent,
  type ConsumedTarget,
  type PendingWindowEntry,
} from "./agent-message-attention-index-helpers";
const logger = getLogger(["coforge", "daemon", "message-attention"]);
export type MessageAttention = Readonly<{
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestCreatedAtMs?: number;
  latestSenderKind?: MessageSenderKind;
  latestSenderHandle?: string;
  flags: readonly string[];
}>;
export class AgentMessageAttentionIndex {
  readonly #generations = new Map<string, NoticeGeneration>();
  readonly #attention = new Map<string, Map<string, MessageAttention>>();
  readonly #consumedByAgent = new Map<string, ConsumedAgent>();
  readonly noticeActionClocks = new NoticeActionClocks();
  readonly #latestThreadReads = new LatestThreadReadIndex();
  readonly #conversationTargets = new Map<string, Map<string, Set<string>>>();
  readonly #attentionConversation = new Map<string, Map<string, string>>();
  readonly #pendingSequences = new Map<string, Map<string, Set<number>>>();
  readonly previewSeen = new PreviewSeen();
  readonly #pendingWindow = new Map<string, Map<string, PendingWindowEntry[]>>();
  readonly #consumedSeqs?: AgentConsumedSeqPort;
  readonly #workspaceId: string;
  readonly #runtimes: Pick<AgentProcessManager, "session"> &
    Partial<Pick<AgentProcessManager, "runtime">>;
  readonly #pendingReads = new PendingAttentionReads({
    attention: this.#attention,
    pendingSequences: this.#pendingSequences,
    pendingWindow: this.#pendingWindow,
    previewSeen: this.previewSeen,
  });
  constructor(
    workspaceId: string,
    runtimes: Pick<AgentProcessManager, "session"> & Partial<Pick<AgentProcessManager, "runtime">>,
    private readonly sendAck: (ack: AgentMessageDeliveryAck) => Promise<void>,
    private readonly messageReceived: (
      agentId: string,
      conversation?: AgentConversationScope,
    ) => void = () => {},
    private readonly hold: {
      shouldHold(agentId: string): boolean;
      enqueue(agentId: string, message: AgentMessageDelivery): void;
      busy(agentId: string): void;
      noticeSettled?(agentId: string): void;
      queued?(agentId: string): readonly AgentMessageDelivery[];
      consumedSeqs?: AgentConsumedSeqPort;
      noticePrefix?(agentId: string): string;
    } = { shouldHold: () => false, enqueue: () => {}, busy: () => {} },
  ) {
    this.#workspaceId = workspaceId;
    this.#runtimes = runtimes;
    this.#consumedSeqs = hold.consumedSeqs;
  }
  async receive(message: AgentMessageDelivery): Promise<void> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (!hasDeliveryScope(message)) throw new Error("invalid agent message scope");
    const generation = this.#generation(message.agentId);
    if (attentionRecorded(generation, message.deliveryId)) {
      if (!generation.notified.has(message.deliveryId)) {
        if (this.#alreadyRead(message.agentId, message)) {
          this.logDecision(message, "consumed");
          await this.acknowledge(message);
          return;
        }

        if (this.hold.shouldHold(message.agentId)) return this.#hold(message);
        const attempt = generation.notificationAttempts.get(message.deliveryId);
        this.logDecision(message, attempt ? "already_notified" : "notified");
        await (attempt ?? this.#notify(message));
        if (this.#generations.get(message.agentId) !== generation) return;
      } else this.logDecision(message, "already_notified");
      await this.acknowledge(message);
      return;
    }
    rememberDelivery(generation, message.deliveryId);
    if (this.#alreadyRead(message.agentId, message)) {
      this.logDecision(message, "consumed");
      await this.acknowledge(message);
      return;
    }
    const current = this.#recordAttention(message);

    if (this.hold.shouldHold(message.agentId)) return this.#hold(message);
    this.logDecision(message, "notified");
    await this.#notify(message, current);
    if (this.#generations.get(message.agentId) !== generation) return;
    await this.acknowledge(message);
  }
  #hold(message: AgentMessageDelivery): void {
    this.logDecision(message, "held");
    this.hold.enqueue(message.agentId, message);
    this.#generation(message.agentId).recordedHeld.add(message.deliveryId);
    this.acknowledgeCustody(message);
  }
  async announce(message: AgentMessageDelivery): Promise<"told" | "gone"> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (!hasDeliveryScope(message)) throw new Error("invalid agent message scope");
    const generation = this.#generation(message.agentId);
    if (!generation.seenDeliveryIds.has(message.deliveryId)) {
      rememberDelivery(generation, message.deliveryId);
      this.logDecision(message, "notified");
      await this.#notify(message, this.#recordAttention(message));
    } else if (
      !generation.notified.has(message.deliveryId) &&
      !this.#alreadyRead(message.agentId, message)
    ) {
      const attempt = generation.notificationAttempts.get(message.deliveryId);
      this.logDecision(message, attempt ? "already_notified" : "notified");
      await (attempt ?? this.#notify(message));
    }
    return this.#generations.get(message.agentId) === generation ? "told" : "gone";
  }
  logDecision(message: AttentionDecisionMessage, outcome: AttentionDecisionOutcome): void {
    logAttentionDecision(
      message,
      outcome,
      this.#consumedByAgent.get(message.agentId),
      message.target ?? "",
    );
  }
  #alreadyRead(
    agentId: string,
    message: {
      target: string;
      sequence: number;
      conversationId: string;
      reason?: string;
    },
  ): boolean {
    if (isCardEvent(message)) return false;
    this.bindConversation(agentId, message.target, message.conversationId);
    return (
      this.hasSeen(agentId, message.target, message.sequence) ||
      this.previewSeen.has(agentId, message.target, message.sequence)
    );
  }
  wasNotified(message: AgentMessageDelivery): boolean {
    return this.#generations.get(message.agentId)?.notified.has(message.deliveryId) === true;
  }
  #recordAttention(
    message: AgentMessageDelivery & {
      target: string;
    },
  ): MessageAttention {
    const target = message.target;
    const latestSender = printableSender(message.latestSenderKind, message.latestSenderHandle);
    const byTarget = this.#attention.get(message.agentId) ?? new Map<string, MessageAttention>();
    const previous = byTarget.get(target);
    const pendingByTarget =
      this.#pendingSequences.get(message.agentId) ?? new Map<string, Set<number>>();
    const pending = pendingByTarget.get(target) ?? new Set<number>();
    pending.add(message.sequence);
    pendingByTarget.set(target, pending);
    this.#pendingSequences.set(message.agentId, pendingByTarget);
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
    this.#attention.set(message.agentId, byTarget);
    this.#recordConversation(message.agentId, target, message.conversationId);
    this.#recordPendingWindow(message.agentId, target, message);
    return current;
  }
  async flush(agentId: string, held: readonly AgentMessageDelivery[]): Promise<void> {
    if (!held.length) return;
    const generation = this.#generation(agentId);
    const settled: AgentMessageDelivery[] = [];
    const announced: AgentMessageDelivery[] = [];
    for (const message of held) {
      if (!hasDeliveryScope(message)) continue;
      settled.push(message);
      if (this.#alreadyRead(agentId, message)) {
        this.logDecision(message, "consumed");
        continue;
      }
      if (attentionRecorded(generation, message.deliveryId)) {
        announced.push(message);
        continue;
      }
      rememberDelivery(generation, message.deliveryId);
      if (this.#alreadyRead(agentId, message)) {
        this.logDecision(message, "consumed");
        continue;
      }
      this.#recordAttention(message);
      announced.push(message);
    }
    if (announced.length) {
      await this.#notify(announced[announced.length - 1]!, undefined, announced);
      if (this.#generations.get(agentId) !== generation) return;
    }
    markFlushed(generation, settled);
  }
  async recover(
    agentId: string,
    messages: readonly AgentRecoveryMessage[],
    unreadSummary: Readonly<Record<string, number>>,
    _unreadConversationIds: Readonly<Record<string, string>> = {},
    conversation?: AgentConversationScope,
  ): Promise<ReadonlySet<string>> {
    const generation = this.#generation(agentId);
    const session = this.#runtimes.session(agentId);
    if (!session?.notify) throw new Error("Agent session cannot receive a wakeup notice");
    const plan = planRecovery({
      agentId,
      messages,
      unreadSummary,
      currentAttention: this.#attention.get(agentId) ?? new Map<string, MessageAttention>(),
      seenDeliveryIds: generation.seenDeliveryIds,
      seenMessageIds: generation.seenMessageIds,
      alreadyRead: (id, message) => this.#alreadyRead(id, message),
      decide: (message, outcome) =>
        this.logDecision({ ...message, workspaceId: this.#workspaceId, agentId }, outcome),
    });
    if (!plan) return new Set();
    const { byTarget, recoveredMessages, announced, notice } = plan;
    this.hold.busy(agentId);
    try {
      await this.#acceptNotice(generation.cancellation.signal, () =>
        session.notify!(notice, conversation ? { conversation } : undefined),
      );
    } finally {
      if (this.#runtimes.session(agentId) === session) this.hold.noticeSettled?.(agentId);
    }
    if (this.#generations.get(agentId) !== generation) return announced;
    this.#attention.set(agentId, byTarget);
    for (const message of recoveredMessages) {
      this.#recordConversation(agentId, message.target, message.conversationId);
      rememberDelivery(generation, message.deliveryId, message.messageId);
      generation.notified.add(message.deliveryId);
      const pendingByTarget = this.#pendingSequences.get(agentId) ?? new Map<string, Set<number>>();
      const pending = pendingByTarget.get(message.target) ?? new Set<number>();
      pending.add(message.sequence);
      pendingByTarget.set(message.target, pending);
      this.#pendingSequences.set(agentId, pendingByTarget);
    }
    if (recoveredMessages.length) this.messageReceived(agentId, conversation);
    return announced;
  }
  #notify(
    message: AgentMessageDelivery,
    attention?: MessageAttention,
    announced: readonly AgentMessageDelivery[] = [message],
  ): Promise<void> {
    const generation = this.#generation(message.agentId);
    const session = this.#runtimes.session(message.agentId);
    if (!session?.notify)
      throw new AgentWakeupUnavailableError("Agent session cannot receive a wakeup notice");
    if (!message.target) return Promise.reject(new Error("delivery target is missing"));
    setContextViewMessageIds(
      session,
      announced.map((item) => item.messageId),
    );
    this.hold.busy(message.agentId);
    void attention;
    const queued = this.hold.queued?.(message.agentId) ?? [];
    const { view, rows, totalCount, notice, trackedIds } = composeDeliveryNotice({
      message,
      announced,
      queued,
      prefix: this.hold.noticePrefix?.(message.agentId) ?? "",
      previewedInFull: (target, sequence) =>
        this.previewSeen.has(message.agentId, target, sequence),
    });
    const notification = Promise.resolve()
      .then(() => {
        if (this.#generations.get(message.agentId) !== generation)
          throw new AgentWakeupUnavailableError("Agent notice was cancelled");
        return this.#acceptNotice(generation.cancellation.signal, () =>
          (trackedIds.length
            ? session.notify!(notice, {
                ...(trackedIds.length ? { deliveryIds: trackedIds } : {}),
              })
            : session.notify!(notice)
          ).then(async () => {
            await session.waitForContextViewCapture?.();
          }),
        );
      })
      .then(() => {
        if (this.#generations.get(message.agentId) === generation) {
          markNotified(generation, [message]);
          this.previewSeen.record(message.agentId, view.whole);
          this.noticeActionClocks.noteNoticeAccepted(message.agentId);
          this.messageReceived(message.agentId);
        }
        logger.info("Agent accepted inbox notice", {
          event: "agent.inbox_notice.accepted",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: rows.length,
          pending_count: countDistinctMessages(announced),
          total_pending_count: totalCount,
          outcome: "ok",
        });
      })
      .catch((error: unknown) => {
        logger.error("Agent rejected inbox notice", {
          event: "agent.inbox_notice.rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: rows.length,
          pending_count: countDistinctMessages(announced),
          total_pending_count: totalCount,
          error_code: diagnosticErrorName(error),
          outcome: "failed",
        });
        throw error;
      })
      .finally(() => {
        if (this.#runtimes.session(message.agentId) === session)
          this.hold.noticeSettled?.(message.agentId);
        if (this.#generations.get(message.agentId) === generation)
          generation.notificationAttempts.delete(message.deliveryId);
      });
    generation.notificationAttempts.set(message.deliveryId, notification);
    return notification;
  }
  async #acceptNotice(signal: AbortSignal, send: () => Promise<void>): Promise<void> {
    return acceptNotice(signal, send);
  }
  #generation(agentId: string) {
    const existing = this.#generations.get(agentId);
    if (existing) return existing;
    const generation = noticeGeneration();
    this.#generations.set(agentId, generation);
    return generation;
  }
  check(agentId: string): MessageAttention[] {
    return [...(this.#attention.get(agentId)?.values() ?? [])];
  }
  hasConsumed(message: AgentMessageDelivery): boolean {
    return hasDeliveryScope(message) && this.#consumed(message);
  }
  acknowledgeCustody(message: AgentMessageDelivery): void {
    void this.acknowledge(message).catch((error: unknown) => {
      logger.warn("Agent delivery could not be acknowledged on taking it", {
        event: "agent.message.custody_ack_failed",
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        error_code: diagnosticErrorName(error),
      });
    });
  }
  acknowledge(message: AgentMessageDelivery): Promise<void> {
    return this.sendAck({
      ...message,
      method: AGENT_MESSAGE_ACK_METHOD,
      requestId: message.requestId,
    });
  }
  recordExactSeen(agentId: string, shown: ReadonlyMap<string, readonly number[]>): void {
    this.#consumedState(agentId);
    let changed = false;
    for (const [target, sequences] of shown) {
      if (!target || !this.#addExact(agentId, target, sequences)) continue;
      changed = true;
      this.#settleSeen(agentId, target);
    }
    if (changed) this.#persist(agentId);
  }
  recordHistoryRead(
    agentId: string,
    read: {
      spelling: string;
      target: string;
      shown: readonly number[];
      through: number;
      review?: {
        sequence: number;
      };
      scope?: Pick<AgentHistoryConsumptionScope, "conversationId" | "channelType" | "target">;
    },
  ): void {
    this.#consumedState(agentId);
    const { target } = read;
    let changed = this.#setAlias(agentId, read.spelling, target);
    if (read.through > 0)
      changed = this.#advanceFrontier(agentId, target, read.through, "history_read") || changed;
    changed = this.#addExact(agentId, target, read.shown) || changed;
    this.#settleSeen(agentId, target);
    if (read.review) {
      this.#takeReadOrder(agentId, target, read.review.sequence);
      changed = true;
    }
    if (read.scope) this.#settleScope(agentId, read.scope, read.shown, target);
    if (changed) this.#persist(agentId);
  }
  recordSendContext(
    agentId: string,
    target: string,
    through: number,
    review?: {
      sequence: number;
    },
  ): void {
    if (!Number.isInteger(through) || through < 1) return;
    const changed = this.#advanceFrontier(agentId, target, through, "send_context");
    if (review) this.#takeReadOrder(agentId, target, review.sequence);
    if (changed || review) this.#persist(agentId);
  }
  seenExactSequences(agentId: string, target: string): readonly number[] {
    return (
      this.previewSeen.mergeExact(
        agentId,
        target,
        this.#consumedState(agentId).targets.get(target)?.exactSeqs,
        SEEN_EXACT_SEQS_LIMIT,
      ) ?? NO_SEQUENCES
    );
  }
  hasExactSeen(agentId: string, target: string): boolean {
    return (
      (this.#consumedState(agentId).targets.get(target)?.exactSeqs?.length ?? 0) > 0 ||
      (this.previewSeen.recorded(agentId, target)?.size ?? 0) > 0
    );
  }
  clearPreviewSeen(agentId: string): void {
    this.previewSeen.clear(agentId);
  }
  resolveTarget(agentId: string, target: string): string {
    return this.#consumedState(agentId).aliases.get(target) ?? target;
  }
  recordTargetAlias(agentId: string, spelling: string, canonical: string): void {
    this.#consumedState(agentId);
    if (this.#setAlias(agentId, spelling, canonical)) this.#persist(agentId);
  }
  hasSeen(agentId: string, target: string, sequence: number): boolean {
    const entry = this.#consumedState(agentId).targets.get(target);
    return (entry?.seq ?? 0) >= sequence || containsSorted(entry?.exactSeqs, sequence);
  }
  #consumed(
    message: AgentMessageDelivery & {
      target: string;
    },
  ): boolean {
    if (isCardEvent(message)) return false;
    if (message.conversationId)
      this.bindConversation(message.agentId, message.target, message.conversationId);
    return this.hasSeen(message.agentId, message.target, message.sequence);
  }
  bindConversation(agentId: string, target: string, conversationId: string): void {
    const entry = this.#targetState(agentId, target);
    const recorded = entry.conversationId;
    if (recorded === conversationId) return;
    entry.conversationId = conversationId;
    if (recorded !== undefined) {
      logger.info("Agent consumed cursor reset for a recreated conversation", {
        event: "agent.message.consumed_cursor_reset",
        agent_id: agentId,
        target,
        previous_conversation_id: recorded,
        conversation_id: conversationId,
        model_seen_seq: entry.seq ?? 0,
      });
      delete entry.seq;
      delete entry.exactSeqs;
      delete entry.reviewedSeq;
      noteFrontierSource(entry, "reset");
      this.#latestThreadReads.clear(agentId);
    }
    this.#persist(agentId);
  }
  #addExact(agentId: string, target: string, sequences: readonly number[]): boolean {
    if (!sequences.length) return false;
    const entry = this.#targetState(agentId, target);
    const existing = entry.exactSeqs ?? NO_SEQUENCES;
    const incoming = isAscending(sequences) ? sequences : [...sequences].sort(byNumber);
    const merged = mergeSeenExactSeqs(entry.seq ?? 0, existing, incoming);
    if (merged.length === existing.length && merged.every((value, i) => value === existing[i]))
      return false;
    entry.exactSeqs = merged;
    return true;
  }
  #advanceFrontier(
    agentId: string,
    target: string,
    sequence: number,
    source: FrontierSource,
  ): boolean {
    const entry = this.#targetState(agentId, target);
    if (sequence <= (entry.seq ?? 0)) return false;
    entry.seq = sequence;
    noteFrontierSource(entry, source);
    const exact = entry.exactSeqs;
    if (exact?.length) {
      const kept = exact.slice(firstAbove(exact, sequence));
      if (!kept.length) delete entry.exactSeqs;
      else if (kept.length !== exact.length) entry.exactSeqs = kept;
    }
    this.#settlePending(agentId, target, (pending) => pending <= sequence);
    return true;
  }
  #settleSeen(agentId: string, target: string): void {
    const entry = this.#consumedState(agentId).targets.get(target);
    const frontier = entry?.seq ?? 0;
    const exact = entry?.exactSeqs;
    this.#settlePending(
      agentId,
      target,
      (sequence) => sequence <= frontier || containsSorted(exact, sequence),
    );
  }
  #settleScope(
    agentId: string,
    scope: Pick<AgentHistoryConsumptionScope, "conversationId" | "channelType" | "target">,
    shown: readonly number[],
    settled: string,
  ): void {
    if (shown.length === 0) return;
    const targets = this.#conversationTargets.get(agentId)?.get(scope.conversationId);
    if (!targets) return;
    const scopeRoot = threadRootTarget(scope.target);
    if (scope.channelType === "thread" && scopeRoot === undefined) return;
    for (const target of targets) {
      if (target === settled) continue;
      const root = threadRootTarget(target);
      if (scope.channelType === "dm" ? root !== undefined : !sameThreadRoot(root, scopeRoot!))
        continue;
      this.#settlePending(agentId, target, (sequence) => containsSorted(shown, sequence));
    }
  }
  #settlePending(agentId: string, target: string, settled: (sequence: number) => boolean): void {
    const pending = this.#pendingSequences.get(agentId)?.get(target);
    if (pending) for (const sequence of pending) if (settled(sequence)) pending.delete(sequence);
    const byTarget = this.#pendingWindow.get(agentId);
    const entries = byTarget?.get(target);
    if (byTarget && entries) {
      const kept = entries.filter((entry) => !settled(entry.delivery.sequence));
      if (kept.length === 0) byTarget.delete(target);
      else if (kept.length !== entries.length) byTarget.set(target, kept);
    }
    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention) return;
    if (!pending || pending.size === 0) {
      this.clear(agentId, target);
      return;
    }
    if (pending.size === attention.pendingCount) return;
    let first = Infinity;
    for (const sequence of pending) if (sequence < first) first = sequence;
    this.#attention.get(agentId)?.set(target, {
      ...attention,
      pendingCount: pending.size,
      firstPendingSequence: first,
    });
  }
  #recordConversation(agentId: string, target: string, conversationId: string): void {
    const byTarget = this.#attentionConversation.get(agentId) ?? new Map<string, string>();
    this.#attentionConversation.set(agentId, byTarget);
    if (byTarget.get(target) === conversationId) return;
    byTarget.set(target, conversationId);
    const byConversation = this.#conversationTargets.get(agentId) ?? new Map<string, Set<string>>();
    this.#conversationTargets.set(agentId, byConversation);
    const targets = byConversation.get(conversationId) ?? new Set<string>();
    targets.add(target);
    byConversation.set(conversationId, targets);
  }
  #forgetConversation(agentId: string, target: string): void {
    const byTarget = this.#attentionConversation.get(agentId);
    const conversationId = byTarget?.get(target);
    if (conversationId === undefined) return;
    byTarget!.delete(target);
    const byConversation = this.#conversationTargets.get(agentId);
    const targets = byConversation?.get(conversationId);
    targets?.delete(target);
    if (targets?.size === 0) byConversation!.delete(conversationId);
  }
  #setAlias(agentId: string, spelling: string, canonical: string): boolean {
    if (!spelling || !canonical || spelling === canonical) return false;
    const { aliases } = this.#consumedState(agentId);
    let target = aliases.get(canonical) ?? canonical;
    if (target === spelling) {
      aliases.delete(canonical);
      target = canonical;
    }
    if (aliases.get(spelling) === target) return false;
    aliases.set(spelling, target);
    for (const [other, named] of aliases) if (named === spelling) aliases.set(other, target);
    return true;
  }
  #takeReadOrder(agentId: string, target: string, sequence: number): void {
    const state = this.#consumedState(agentId);
    const entry = this.#targetState(agentId, target);
    if (Number.isInteger(sequence) && sequence > 0)
      entry.reviewedSeq = Math.max(entry.reviewedSeq ?? 0, sequence);
    entry.readOrder = ++state.lastReadOrder;
    this.#latestThreadReads.record(agentId, target, entry);
  }
  #persist(agentId: string): void {
    const store = this.#consumedSeqs;
    if (!store) return;
    const state = this.#consumedState(agentId);
    store.write(agentId, consumedSnapshot(state));
  }
  modelSeenSequence(agentId: string, target: string): number {
    return this.#consumedState(agentId).targets.get(target)?.seq ?? 0;
  }
  unreadDeliveries(agentId: string): {
    target: string;
    count: number;
  }[] {
    return this.#pendingReads.unreadDeliveries(agentId);
  }
  pendingMessageCount(agentId: string, target: string): number {
    return this.#pendingReads.pendingMessageCount(agentId, target);
  }
  pendingMaxSequence(agentId: string, target: string): number {
    return this.#pendingReads.pendingMaxSequence(agentId, target);
  }
  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    return this.#pendingReads.pendingWindow(agentId, target, limit);
  }
  #recordPendingWindow(agentId: string, target: string, delivery: AgentMessageDelivery): void {
    const byTarget = this.#pendingWindow.get(agentId) ?? new Map<string, PendingWindowEntry[]>();
    const entries = byTarget.get(target) ?? [];
    entries.push({ delivery, receivedAt: Date.now() });
    if (entries.length > PENDING_WINDOW_LIMIT)
      entries.splice(0, entries.length - PENDING_WINDOW_LIMIT);
    byTarget.set(target, entries);
    this.#pendingWindow.set(agentId, byTarget);
  }
  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    if (this.#advanceFrontier(agentId, target, sequence, "model_seen")) this.#persist(agentId);
  }
  recordReadContext(agentId: string, target: string, sequence = 0): void {
    this.#takeReadOrder(agentId, target, sequence);
    this.#persist(agentId);
  }
  readOrder(agentId: string, target: string): number | undefined {
    return this.#consumedState(agentId).targets.get(target)?.readOrder;
  }
  latestThreadReadUnderParent(
    agentId: string,
    parentTarget: string,
  ):
    | {
        target: string;
        order: number;
      }
    | undefined {
    return this.#latestThreadReads.get(agentId, parentTarget, this.#consumedState(agentId).targets);
  }
  #consumedState(agentId: string): ConsumedAgent {
    const existing = this.#consumedByAgent.get(agentId);
    if (existing) return existing;
    const state: ConsumedAgent = { targets: new Map(), aliases: new Map(), lastReadOrder: 0 };
    this.#consumedByAgent.set(agentId, state);
    if (this.#consumedSeqs) {
      const saved = this.#consumedSeqs.read(agentId);
      for (const [target, entry] of Object.entries(saved.targets))
        state.targets.set(target, { ...entry });
      state.aliases = new Map(Object.entries(saved.aliases));
      state.lastReadOrder = saved.nextReadOrder - 1;
    }
    return state;
  }
  #targetState(agentId: string, target: string): ConsumedTarget {
    const { targets } = this.#consumedState(agentId);
    const existing = targets.get(target);
    if (existing) return existing;
    const entry: ConsumedTarget = {};
    targets.set(target, entry);
    return entry;
  }
  clearAgent(
    agentId: string,
    {
      cancelNotices = false,
    }: {
      cancelNotices?: boolean;
    } = {},
  ): void {
    this.#consumedByAgent.delete(agentId);
    this.#latestThreadReads.clear(agentId);
    if (cancelNotices)
      this.#generations.get(agentId)?.cancellation.abort(new Error("Agent notice was cancelled"));
    this.#generations.delete(agentId);
    this.#attention.delete(agentId);
    this.#conversationTargets.delete(agentId);
    this.#attentionConversation.delete(agentId);
    this.#pendingSequences.delete(agentId);
    this.#pendingWindow.delete(agentId);
  }
  clearTargets(agentId: string, targets: readonly string[]): void {
    const lost = (target: string) =>
      targets.some((channel) => target === channel || target.startsWith(`${channel}:`));
    const keys = new Set([
      ...(this.#attention.get(agentId)?.keys() ?? []),
      ...(this.#pendingSequences.get(agentId)?.keys() ?? []),
      ...(this.#pendingWindow.get(agentId)?.keys() ?? []),
    ]);
    for (const target of keys) if (lost(target)) this.clear(agentId, target);
  }
  clear(agentId: string, target: string): void {
    this.#forgetConversation(agentId, target);
    this.#pendingSequences.get(agentId)?.delete(target);
    this.#pendingWindow.get(agentId)?.delete(target);
    const byTarget = this.#attention.get(agentId);
    byTarget?.delete(target);
    if (byTarget?.size === 0) this.#attention.delete(agentId);
  }
  clearThrough(agentId: string, target: string, sequence: number): void {
    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention || attention.latestSequence <= sequence) this.clear(agentId, target);
  }
}
const NO_SEQUENCES: readonly number[] = [];
