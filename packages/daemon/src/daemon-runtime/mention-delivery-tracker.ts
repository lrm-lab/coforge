import { getLogger } from "@logtape/logtape";
import {
  MENTION_DELIVERY_TERMINAL_CODES,
  type AgentMessageDelivery,
  type MentionDeliveryEnvelope,
  type MentionDeliveryTerminalCode,
} from "@lrm/coforge-sdk/internal";
import type { MentionDeliveryPorts } from "./mention-delivery-ports";
import { MentionDeliveryReports } from "./mention-delivery-reports";
import { MentionCarry } from "./mention-carry";
import {
  blockOutcome,
  MentionEntries,
  namesLaunch,
  REMEMBERED_MENTIONS,
  type Tracked,
} from "./mention-delivery-entries";

/** The running identity a tracked mention is checked against, as the runtime names it. */
export type { RunningMentionIdentity } from "./mention-delivery-ports";
import { AgentWakeupUnavailableError } from "./agent-wakeup-unavailable-error";

const logger = getLogger(["coforge", "daemon", "mention-delivery"]);

/** A delivery carrying a tracked @mention envelope. */
export type TrackedMentionDelivery = AgentMessageDelivery & {
  mentionDelivery: MentionDeliveryEnvelope;
};

export function isTrackedMention(message: AgentMessageDelivery): message is TrackedMentionDelivery {
  return message.mentionDelivery !== undefined;
}

/**
 * The daemon's side of tracked @mention delivery. A tracked delivery is ACKed, with its envelope
 * echoed, only once it is drained: told to the launch and session its envelope names while the
 * Agent was idle, told during a turn that has since ended, or already consumed. Otherwise the
 * daemon reports the terminal error that explains why it will not be. State lives in memory
 * only: the server issues a pending envelope again with the same delivery id, and a daemon restart
 * starts over. Nothing is reported when a process exits, when an Agent is stopped or when the daemon
 * stops.
 */
export class MentionDeliveryTracker {
  /** Terminal reports already sent, by delivery and envelope: the same issue is refused once, even
   * when its in-flight notice fails after it was refused another way. A re-issue for another launch
   * or session is a new issue. */
  readonly #refused = new Set<string>();
  readonly #entries = new MentionEntries();
  /** What each Agent's cancellation drops besides its mentions (see `whenCancelled`). */
  readonly #cancelHooks = new Map<string, () => void>();
  readonly #reports: MentionDeliveryReports;
  /** The mentions kept for the launch that follows a restart. */
  readonly carry: MentionCarry;

  constructor(
    private readonly computerId: string,
    private readonly ports: MentionDeliveryPorts,
  ) {
    this.#reports = new MentionDeliveryReports(ports);
    this.carry = new MentionCarry(this.#entries, ports, this.#reports, {
      drain: (message) => this.#drain(message),
      refuse: (message, code) => this.refuse(message, code),
    });
  }

  /** Why the envelope cannot belong to this delivery on this Computer, checked on receipt before
   * the delivery is queued anywhere; undefined when it can. */
  admissionRefusal(message: TrackedMentionDelivery): MentionDeliveryTerminalCode | undefined {
    if (message.mentionDelivery.computerId !== this.computerId)
      return MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT;
    if (message.mentionDelivery.messageId !== message.messageId)
      return MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED;
    return undefined;
  }

  /**
   * Tells a tracked mention to the Agent's running session and settles what follows. The envelope
   * must name the running launch and session before anything else is asked, as the reference
   * Computer does: only then is a repeat of a drained mention ACKed again, and a repeat of one
   * still being told coalesced. A consumed message is drained, and otherwise the mention is told.
   * Told while the Agent is idle, it is drained; told during a turn, it stays pending until that
   * turn ends. Rejects only when the session refused the notice (after reporting it).
   */
  async deliver(message: TrackedMentionDelivery): Promise<void> {
    const kept = this.#entries.get(message.deliveryId);
    if (kept?.carried && kept.message.agentId === message.agentId) {
      // Told as the newest issue the server made while it waited, which the entry holds.
      this.#entries.uncarry(kept);
      return this.#drainIfConsumed(kept.message) ?? this.#tell(kept.message, kept);
    }
    const running = this.ports.running(message.agentId);
    if (!running) return this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN);
    if (!namesLaunch(running, message.mentionDelivery))
      return this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT);
    const existing = this.#entries.get(message.deliveryId);
    if (existing) {
      if (
        existing.message.agentId !== message.agentId ||
        existing.message.messageId !== message.messageId
      )
        return this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED);
      if (existing.state === "drained") {
        existing.message = message;
        return this.#reports.acknowledge(message);
      }
      // Still pending or being told: the repeat is coalesced into it with the newest envelope,
      // whatever launch it names (it names the running one, checked above).
      existing.message = message;
      this.#reports.transition(message, "daemon_pending", "coalesced");
      return;
    }
    const consumed = this.#drainIfConsumed(message);
    if (consumed) return consumed;
    this.#entries.set(message, "received");
    this.#reports.transition(message, "daemon_received", "accepted");
    return this.#tell(message, this.#entries.get(message.deliveryId));
  }

  /** Drains the mention when the Agent's consumed cursor already covers it. */
  #drainIfConsumed(message: TrackedMentionDelivery): Promise<void> | undefined {
    if (!this.ports.consumed(message)) return undefined;
    this.ports.decided?.(message, "consumed");
    return this.#drain(message);
  }

  /** Tells the Agent's running session about an admitted mention and settles what follows. */
  async #tell(message: TrackedMentionDelivery, receiving: Tracked | undefined): Promise<void> {
    const envelope = message.mentionDelivery;
    if (this.ports.told(message)) {
      this.ports.decided?.(message, "already_notified");
      return this.#told(message);
    }
    // Read before the notice: writing it marks the Agent busy.
    const busy = this.ports.busy(message.agentId, message.conversationId);
    const blocked = blockOutcome(this.ports.blocked(message.agentId), busy);
    if (blocked === "keep") return void this.carry.hold(message, true);
    if (blocked) return this.refuse(message, blocked);
    const process = this.ports.process?.(message.agentId);
    if (receiving) receiving.inflight = true;
    let outcome: "told" | "gone";
    try {
      outcome = await this.ports.announce(message);
    } catch (error) {
      if (receiving) delete receiving.inflight;
      if (this.#entries.get(message.deliveryId) === receiving) {
        if (receiving && this.carry.replaced(receiving, message.agentId, process)) throw error;
        // A wakeup that lost its session (cancelled mid-notice, session gone) is transient:
        // report IDENTITY_UNKNOWN, which the server answers by waking the Agent and re-issuing
        // the mention for the relaunched session — not by settling it lost.
        const transient = error instanceof AgentWakeupUnavailableError;
        await this.refuse(
          message,
          transient
            ? MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN
            : MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
          error instanceof Error ? error.message : undefined,
        );
      }
      throw error;
    }
    if (receiving) delete receiving.inflight;
    if (this.#entries.get(message.deliveryId) !== receiving) return;
    if (receiving && this.carry.replaced(receiving, message.agentId, process)) return;
    if (outcome === "gone") {
      const now = this.ports.running(message.agentId);
      return this.refuse(
        message,
        now && !namesLaunch(now, envelope)
          ? MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT
          : MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
      );
    }
    // Native acceptance can arrive after the turn's completion callback. Recheck before
    // entering pending, since that earlier callback could not settle an unaccepted delivery.
    // A repeat that arrived meanwhile was coalesced into the entry: settle with its envelope.
    const newest = receiving?.message ?? message;
    return busy &&
      this.ports.busy(message.agentId, message.conversationId) &&
      !this.ports.consumed(newest)
      ? this.#markPending(newest)
      : this.#drain(newest);
  }

  /**
   * Settles a delivery the daemon is dropping without telling any session. Returns false for an
   * untracked delivery, which the caller settles its own way. A tracked one is drained when the
   * Agent already consumed it, and otherwise refused with `code`.
   */
  drop(message: AgentMessageDelivery, code: MentionDeliveryTerminalCode): boolean {
    if (!isTrackedMention(message)) return false;
    void (this.ports.consumed(message) ? this.#drain(message) : this.refuse(message, code));
    return true;
  }

  /**
   * The Agent's turn ended: each mention still pending for it ends here, or it would stay pending
   * with nothing left to tell the Agent and every re-issue would only be coalesced. One the current
   * session was told, or the Agent consumed, is drained; one whose notice the session reported lost
   * waits for that notice's redelivery; any other (told to a process that has since exited) is
   * rejected. Every verdict is applied to the tracker's state in this one synchronous pass; the
   * reports follow without being waited for, so none of them delays another's settlement.
   */
  settleTurnEnd(agentId: string, conversationId?: string): void {
    const pending = this.#entries.pending(agentId);
    if (!pending) return;
    for (const deliveryId of [...pending]) {
      const tracked = this.#entries.get(deliveryId);
      if (!tracked || tracked.undelivered) continue;
      const { message } = tracked;
      if (conversationId !== undefined && message.conversationId !== conversationId) continue;
      if (this.ports.told(message) || this.ports.consumed(message)) void this.#drain(message);
      else void this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
    }
  }

  /** Whether a mention of the Agent is open: its idle checks wait for it to settle. */
  hasOpen(agentId: string): boolean {
    return this.#entries.hasOpen(agentId);
  }

  /** The Agent's consumed cursor moved: each mention it was told in a turn, or that waits for its
   * next launch, drains as soon as the model has seen the message, not when the turn ends. A
   * mention whose notice is still being written settles when the write does. */
  settleConsumed(agentId: string): void {
    const open = [
      ...[...(this.#entries.pending(agentId) ?? [])].flatMap((id) => this.#entries.get(id) ?? []),
      ...this.#entries.carriedOf(agentId),
    ];
    for (const entry of open) {
      const { message } = entry;
      // Asking whether it is consumed can bind a conversation and write the cursor, which settles
      // again: an entry a nested pass already settled is not settled twice.
      if (entry.inflight || this.#entries.get(message.deliveryId) !== entry) continue;
      if (!this.ports.consumed(message) || this.#entries.get(message.deliveryId) !== entry)
        continue;
      this.ports.decided?.(message, "consumed");
      void this.#drain(message);
    }
  }

  /** Records that the session never showed the model the notice carrying these deliveries: they
   * stay unacknowledged until that notice's redelivery settles them (`settleRedelivery`). */
  markUndelivered(agentId: string, deliveryIds: readonly string[]): void {
    for (const deliveryId of deliveryIds) {
      const tracked = this.#entries.get(deliveryId);
      if (tracked?.message.agentId === agentId && tracked.state !== "drained")
        tracked.undelivered = true;
    }
  }

  /** The notice that carried these deliveries was delivered again after its turn ended: drained
   * once the session accepted it, rejected when it did not. As for a turn's end, the verdicts are
   * applied now and their reports are not waited for. */
  settleRedelivery(agentId: string, deliveryIds: readonly string[], accepted: boolean): void {
    for (const deliveryId of deliveryIds) {
      const tracked = this.#entries.get(deliveryId);
      if (tracked?.message.agentId !== agentId || !tracked.undelivered) continue;
      if (accepted) void this.#drain(tracked.message);
      else void this.refuse(tracked.message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
    }
  }

  /** Reports that the daemon will not tell a mention, and forgets it. */
  async refuse(
    message: TrackedMentionDelivery,
    code: MentionDeliveryTerminalCode,
    detail?: string,
  ): Promise<void> {
    await this.#refuse(message, code, detail);
  }

  /** `refuse`, saying whether the report was sent. */
  async #refuse(
    message: TrackedMentionDelivery,
    code: MentionDeliveryTerminalCode,
    detail?: string,
  ): Promise<boolean> {
    this.#entries.forget(message.deliveryId);
    const { launchId, sessionId } = message.mentionDelivery;
    const issue = `${message.deliveryId}\n${launchId}\n${sessionId}`;
    if (this.#refused.has(issue)) return false;
    this.#refused.add(issue);
    if (this.#refused.size > REMEMBERED_MENTIONS)
      this.#refused.delete(this.#refused.values().next().value!);
    logger.info("Tracked mention delivery refused", {
      event: "agent.mention_delivery.terminal_error",
      agent_id: message.agentId,
      delivery_id: message.deliveryId,
      code,
      ...(detail ? { detail } : {}),
    });
    return this.#reports.terminalError(message, code);
  }

  /** Registers what to drop when the Agent's waits are cancelled; the Agent keeps one hook. */
  whenCancelled(agentId: string, hook: () => void): void {
    this.#cancelHooks.set(agentId, hook);
  }

  /** The daemon is stopping: every Agent's waits are cancelled, and the mentions kept for a launch
   * are forgotten without a report. */
  cancelAll(): void {
    for (const agentId of this.#cancelHooks.keys()) this.#runCancelHook(agentId);
    this.carry.forgetAllCarried();
  }

  #runCancelHook(agentId: string): void {
    const hook = this.#cancelHooks.get(agentId);
    this.#cancelHooks.delete(agentId);
    hook?.();
  }

  /** The daemon is shutting an Agent down: its waits end and the mentions it had not drained are
   * forgotten without a report. */
  cancelAgent(agentId: string): void {
    this.#runCancelHook(agentId);
    this.#forgetUnsettled(agentId, new Set());
  }

  /** A Stop begins: the Agent's waits end, and every report about its mentions is held until
   * `endStop` drops it. */
  beginStop(agentId: string): void {
    this.#runCancelHook(agentId);
    this.#reports.hold(agentId);
  }

  /** The Stop ended (it always completes): the mentions the Agent had not drained and the reports
   * held for them are forgotten, as the reference Computer sends nothing for them. The cloud owns
   * what becomes of them: a person's Stop settles them there; any other stop leaves them pending
   * for its re-issue to the next launch, which tells each once. Cancellation is never a drain. */
  endStop(agentId: string): void {
    this.#forgetUnsettled(agentId, this.#reports.drop(agentId));
  }

  #forgetUnsettled(agentId: string, alsoDrained: ReadonlySet<string>): void {
    for (const { message, state } of this.#entries.all())
      if (
        message.agentId === agentId &&
        (state !== "drained" || alsoDrained.has(message.deliveryId))
      )
        this.#entries.forget(message.deliveryId);
  }

  /** Already told in the current session: pending while that turn runs, drained once idle. */
  #told(message: TrackedMentionDelivery): Promise<void> {
    return this.ports.busy(message.agentId, message.conversationId)
      ? this.#markPending(message)
      : this.#drain(message);
  }

  async #markPending(message: TrackedMentionDelivery): Promise<void> {
    this.#entries.set(message, "pending");
    this.#reports.transition(message, "daemon_pending", "accepted");
  }

  async #drain(message: TrackedMentionDelivery): Promise<void> {
    if (this.#entries.get(message.deliveryId)?.state !== "drained") {
      this.#entries.set(message, "drained");
      this.#reports.transition(message, "daemon_drained", "accepted");
    }
    await this.#reports.acknowledge(message);
  }
}
