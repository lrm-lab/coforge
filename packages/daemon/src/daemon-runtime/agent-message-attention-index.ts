import {
  AGENT_MESSAGE_ACK_METHOD,
  diagnosticErrorName,
  type AgentMessageDelivery,
  type AgentMessageDeliveryAck,
  type AgentRecoveryMessage,
  type AgentStartOpenTasks,
  type MessageSenderKind,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { AgentConversationScope } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { NoticeActionClocks } from "./notice-action-clocks";
import { type AgentDeliveryQueue, writeDeliveryNotice } from "./delivery-notice-writer";
import { rememberDelivery } from "./delivery-generation-memory";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { hasDeliveryScope } from "./message-attention-fields";
import {
  acceptNotice,
  noticeGeneration,
  type NoticeGeneration,
} from "./agent-wakeup-unavailable-error";
import { PreviewSeen } from "./inbox-preview-rows";
import {
  logAttentionDecision,
  logRecoveryNoticeAccepted,
  type AttentionDecisionMessage,
  type AttentionDecisionOutcome,
  type AttentionDedupBasis,
} from "./agent-message-attention-decision-log";
import { planRecovery, type RecoveryNoticeOptions } from "./agent-message-attention-recovery";
import { AgentConsumedAttention } from "./agent-consumed-attention";
import { PendingAttention } from "./agent-message-attention-pending";
import { AcceptedMessageNotices } from "./accepted-message-notices";
import {
  attentionRecorded,
  isCardEvent,
  markFlushed,
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
  readonly #acceptedNotices = new AcceptedMessageNotices();
  readonly #generations = new Map<string, NoticeGeneration>();
  readonly #attention = new Map<string, Map<string, MessageAttention>>();
  readonly noticeActionClocks = new NoticeActionClocks();
  readonly #pendingSequences = new Map<string, Map<string, Set<number>>>();
  readonly previewSeen = new PreviewSeen();
  readonly #pendingWindow = new Map<string, Map<string, PendingWindowEntry[]>>();
  readonly #workspaceId: string;
  readonly #runtimes: Pick<AgentProcessManager, "session"> &
    Partial<Pick<AgentProcessManager, "runtime">>;
  readonly #pending = new PendingAttention({
    attention: this.#attention,
    pendingSequences: this.#pendingSequences,
    pendingWindow: this.#pendingWindow,
    previewSeen: this.previewSeen,
  });
  readonly #consumption = new AgentConsumedAttention({
    store: () => this.hold.consumedSeqs,
    previewSeen: this.previewSeen,
    settlePending: (agentId, target, settled) =>
      this.#pending.settle(agentId, target, settled, (id, name) => this.clear(id, name)),
  });
  constructor(
    workspaceId: string,
    runtimes: Pick<AgentProcessManager, "session"> & Partial<Pick<AgentProcessManager, "runtime">>,
    private readonly sendAck: (ack: AgentMessageDeliveryAck) => Promise<void>,
    private readonly messageReceived: (
      agentId: string,
      conversation?: AgentConversationScope,
    ) => void = () => {},
    private readonly hold: AgentDeliveryQueue = {
      shouldHold: () => false,
      enqueue: () => {},
      busy: () => {},
    },
  ) {
    this.#workspaceId = workspaceId;
    this.#runtimes = runtimes;
  }
  async receive(message: AgentMessageDelivery): Promise<void> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (!hasDeliveryScope(message)) throw new Error("invalid agent message scope");
    if (this.#acceptedNotices.has(message.agentId, message)) {
      this.logDecision(message, "already_notified", "accepted_message");
      await this.acknowledge(message);
      return;
    }
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
  logDecision(
    message: AttentionDecisionMessage,
    outcome: AttentionDecisionOutcome,
    basis?: AttentionDedupBasis,
  ): void {
    logAttentionDecision(
      message,
      outcome,
      this.#consumption.peek(message.agentId),
      message.target ?? "",
      basis,
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
  #recordAttention(message: AgentMessageDelivery & { target: string }): MessageAttention {
    const current = this.#pending.record(message);
    this.#consumption.recordConversation(message.agentId, message.target, message.conversationId);
    this.#pending.recordWindow(message.agentId, message.target, message);
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
      if (this.#acceptedNotices.has(agentId, message)) {
        this.logDecision(message, "already_notified", "accepted_message");
        continue;
      }
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
    unreadConversationIds: Readonly<Record<string, string>> = {},
    conversation?: AgentConversationScope,
    openTasks?: AgentStartOpenTasks,
    options?: RecoveryNoticeOptions,
  ): Promise<ReadonlySet<string>> {
    const generation = this.#generation(agentId);
    const session = this.#runtimes.session(agentId);
    if (!session?.notify) throw new Error("Agent session cannot receive a wakeup notice");
    const plan = planRecovery({
      agentId,
      messages,
      unreadSummary,
      unreadConversationIds,
      snapshotMessages: options?.snapshotMessages ?? messages,
      countedDeliveries: options?.countedDeliveries,
      openTasks,
      currentAttention: this.#attention.get(agentId) ?? new Map<string, MessageAttention>(),
      seenDeliveryIds: generation.seenDeliveryIds,
      seenMessageIds: generation.seenMessageIds,
      alreadyRead: (id, message) => this.#alreadyRead(id, message),
      alreadyNotified: (message) => this.#acceptedNotices.has(agentId, message),
      decide: (message, outcome, basis) =>
        this.logDecision({ ...message, workspaceId: this.#workspaceId, agentId }, outcome, basis),
    });
    if (!plan) return new Set();
    const { byTarget, recoveredMessages, acceptedMessages, announced, notice } = plan;
    const recordAccepted = this.captureNoticeAcceptance(agentId);
    this.hold.busy(agentId);
    try {
      await this.#acceptNotice(generation.cancellation.signal, () =>
        session.notify!(notice, conversation ? { conversation } : undefined),
      );
    } finally {
      if (this.#runtimes.session(agentId) === session) this.hold.noticeSettled?.(agentId);
    }
    if (this.#generations.get(agentId) !== generation) return announced;
    if (!recordAccepted(acceptedMessages)) return announced;
    logRecoveryNoticeAccepted(this.#workspaceId, agentId, plan);
    options?.accepted(acceptedMessages);
    this.#attention.set(agentId, byTarget);
    for (const message of recoveredMessages) {
      this.#consumption.recordConversation(agentId, message.target, message.conversationId);
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
    return writeDeliveryNotice.call(
      {
        session: (agentId) => this.session(agentId),
        generation: (agentId) => this.#generation(agentId),
        isCurrentGeneration: (agentId, generation) => this.isCurrentGeneration(agentId, generation),
        hold: this.hold,
        previewSeen: this.previewSeen,
        noticeActionClocks: this.noticeActionClocks,
        messageReceived: (agentId, conversation) => this.messageReceived(agentId, conversation),
        acceptNotice: (signal, send) => this.#acceptNotice(signal, send),
        recordAccepted: this.captureNoticeAcceptance(message.agentId),
      },
      message,
      attention,
      announced,
    );
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
  session(agentId: string) {
    return this.#runtimes.session(agentId);
  }
  isCurrentGeneration(agentId: string, generation: NoticeGeneration): boolean {
    return this.#generations.get(agentId) === generation;
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
  recordExactSeen(...args: Parameters<AgentConsumedAttention["recordExactSeen"]>) {
    return this.#consumption.recordExactSeen(...args);
  }
  recordHistoryRead(...args: Parameters<AgentConsumedAttention["recordHistoryRead"]>) {
    return this.#consumption.recordHistoryRead(...args);
  }
  recordSendContext(...args: Parameters<AgentConsumedAttention["recordSendContext"]>) {
    return this.#consumption.recordSendContext(...args);
  }
  seenExactSequences(...args: Parameters<AgentConsumedAttention["seenExactSequences"]>) {
    return this.#consumption.seenExactSequences(...args);
  }
  hasExactSeen(...args: Parameters<AgentConsumedAttention["hasExactSeen"]>) {
    return this.#consumption.hasExactSeen(...args);
  }
  resolveTarget(...args: Parameters<AgentConsumedAttention["resolveTarget"]>) {
    return this.#consumption.resolveTarget(...args);
  }
  recordTargetAlias(...args: Parameters<AgentConsumedAttention["recordTargetAlias"]>) {
    return this.#consumption.recordTargetAlias(...args);
  }
  hasSeen(...args: Parameters<AgentConsumedAttention["hasSeen"]>) {
    return this.#consumption.hasSeen(...args);
  }
  bindConversation(...args: Parameters<AgentConsumedAttention["bindConversation"]>) {
    return this.#consumption.bindConversation(...args);
  }
  modelSeenSequence(...args: Parameters<AgentConsumedAttention["modelSeenSequence"]>) {
    return this.#consumption.modelSeenSequence(...args);
  }
  recordModelSeen(...args: Parameters<AgentConsumedAttention["recordModelSeen"]>) {
    return this.#consumption.recordModelSeen(...args);
  }
  recordReadContext(...args: Parameters<AgentConsumedAttention["recordReadContext"]>) {
    return this.#consumption.recordReadContext(...args);
  }
  readOrder(...args: Parameters<AgentConsumedAttention["readOrder"]>) {
    return this.#consumption.readOrder(...args);
  }
  latestThreadReadUnderParent(
    ...args: Parameters<AgentConsumedAttention["latestThreadReadUnderParent"]>
  ) {
    return this.#consumption.latestThreadReadUnderParent(...args);
  }
  clearPreviewSeen(agentId: string): void {
    this.previewSeen.clear(agentId);
  }
  beginNoticeContext(agentId: string): void {
    this.#acceptedNotices.begin(agentId);
  }
  confirmNoticeContext(
    agentId: string,
    provider: RuntimeProvider,
    sessionId: string,
    resumed: boolean,
  ): void {
    this.#acceptedNotices.confirm(agentId, provider, sessionId, resumed);
  }
  resetNoticeContext(agentId: string): void {
    this.#acceptedNotices.reset(agentId);
    this.#generations.get(agentId)?.seenMessageIds.clear();
  }
  captureNoticeAcceptance(agentId: string) {
    return this.#acceptedNotices.acceptance(agentId);
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
  unreadDeliveries(agentId: string): {
    target: string;
    count: number;
  }[] {
    return this.#pending.unreadDeliveries(agentId);
  }
  pendingMessageCount(agentId: string, target: string): number {
    return this.#pending.pendingMessageCount(agentId, target);
  }
  pendingMaxSequence(agentId: string, target: string): number {
    return this.#pending.pendingMaxSequence(agentId, target);
  }
  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    return this.#pending.pendingWindow(agentId, target, limit);
  }
  clearAgent(
    agentId: string,
    {
      cancelNotices = false,
    }: {
      cancelNotices?: boolean;
    } = {},
  ): void {
    if (cancelNotices) this.#acceptedNotices.forget(agentId);
    else this.#acceptedNotices.pause(agentId);
    this.#consumption.clearAgent(agentId);
    if (cancelNotices)
      this.#generations.get(agentId)?.cancellation.abort(new Error("Agent notice was cancelled"));
    this.#generations.delete(agentId);
    this.#attention.delete(agentId);
    this.#pendingSequences.delete(agentId);
    this.#pendingWindow.delete(agentId);
  }
  clearTargets(agentId: string, targets: readonly string[]): void {
    const lost = (target: string) =>
      targets.some((channel) => target === channel || target.startsWith(`${channel}:`));
    this.#acceptedNotices.prune(
      agentId,
      (message) => message.target !== undefined && lost(message.target),
    );
    const keys = new Set([
      ...(this.#attention.get(agentId)?.keys() ?? []),
      ...(this.#pendingSequences.get(agentId)?.keys() ?? []),
      ...(this.#pendingWindow.get(agentId)?.keys() ?? []),
    ]);
    for (const target of keys) if (lost(target)) this.clear(agentId, target);
  }
  clear(agentId: string, target: string): void {
    this.#consumption.forgetConversation(agentId, target);
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
