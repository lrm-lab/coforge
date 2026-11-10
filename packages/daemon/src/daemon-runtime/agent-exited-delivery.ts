import { getLogger } from "@logtape/logtape";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import {
  diagnosticErrorName,
  MENTION_DELIVERY_TERMINAL_CODES,
  type MentionDeliveryTerminalCode,
} from "@lrm/coforge-sdk/internal";
import type { TrackedMentionDelivery } from "./mention-delivery-tracker";
import { scheduleUnrefTimer } from "./unref-timer";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How a delivery is settled for an Agent with no hold, session, or launch in flight. */
export type AgentExitedDeliveryPorts = Readonly<{
  /** A runtime-error backoff that must survive an unexpected process exit. */
  hasRuntimeErrorHold(agentId: string): boolean;
  /** The hold is a retryable-error backoff, which ends by itself; a tripped fence's does not. */
  backoffHeld(agentId: string): boolean;
  /** Records a delivery in attention and the daemon-owned hold without waking a process. */
  holdRuntimeErrorDelivery(message: AgentMessageDelivery): Promise<void>;
  /** The consumed cursor already covers this delivery. */
  hasConsumed(message: AgentMessageDelivery): boolean;
  logConsumed(message: AgentMessageDelivery): void;
  acknowledge(message: AgentMessageDelivery): Promise<void>;
  acknowledgeCustody(message: AgentMessageDelivery): void;
  /** The daemon-side relaunch config a wake launch needs, or undefined. */
  restartConfig(agentId: string): AgentRestartConfig | undefined;
  /** A server Start is being set up or waiting out a launch-retry cooldown. */
  startPending(agentId: string): boolean;
  /** Deliveries already wait for this Agent's next launch. */
  hasQueued(agentId: string): boolean;
  /** Records a delivery in `AgentDeliveryGate` as waiting for the next launch. */
  queueForNextLaunch(agentId: string, message: AgentMessageDelivery): void;
  /** The wake launch cooldown's end instant, when one is in force. */
  wakeBlockedUntil(agentId: string): number | undefined;
  /** Runs `hook` when the Agent's waits are cancelled (a Stop, a purge, the daemon stopping). */
  whenCancelled(agentId: string, hook: () => void): void;
  /** Queues a delivery as the Agent's next input; settles once the input drain handled it. */
  enqueueInputDelivery(agentId: string, message: AgentMessageDelivery): Promise<void>;
  wakeAgent(agentId: string, restart: AgentRestartConfig): Promise<unknown>;
  /** The runtime-error offline record: `has` routes to custody, `restate` resends
   * `inactive` + the failure's Activity at a fresh clientSeq. */
  offline: Readonly<{ has(agentId: string): boolean; restate(agentId: string): void }>;
  /** Delivery-kind messages still waiting in the Agent's launch input queue (no removal; the
   * caller's `closeAgentInputQueue` then errors every item). */
  queuedInputDeliveries(agentId: string): AgentMessageDelivery[];
  /** Removes and returns the delivery-kind items still waiting in the Agent's launch input
   * queue, resolving each kept item's completion — they are kept, not failed. */
  drainInputDeliveries(agentId: string): AgentMessageDelivery[];
  closeAgentInputQueue(agentId: string, error: unknown): void;
  /** Settles a tracked @mention as `IDENTITY_UNKNOWN`; true when the delivery was one. */
  dropMentionAsUnknown(message: AgentMessageDelivery): boolean;
  /** Keeps a tracked @mention for the launch that is coming; true when the delivery was one. */
  holdMention(message: AgentMessageDelivery): boolean;
  /** Keeps a tracked @mention that arrived for an Agent with no process; true when it is kept. */
  keepMention(message: AgentMessageDelivery): boolean;
  /** Whether tracked @mentions are kept for the Agent's next launch. */
  hasKeptMentions(agentId: string): boolean;
  /** No launch is coming: the mentions kept for it are refused with `code`. */
  refuseKeptMentions(agentId: string, code: MentionDeliveryTerminalCode): void;
  sendAgentStatus(agentId: string, status: "inactive"): void;
  sendAgentDeliveryRejection(message: AgentMessageDelivery, reason: "no_process"): Promise<void>;
  /** The Agent's session is registered (a pending-Start buffer releases only into one). */
  hasSession(agentId: string): boolean;
  /** A session is registered, a launch is in flight or a server Start is pending: that launch
   * tells what is kept, so a wake would only join it. */
  launchComing(agentId: string): boolean;
  /** Re-admits a buffered delivery through the ordinary delivery path. */
  redeliver(message: AgentMessageDelivery): void;
}>;

/**
 * Settles a delivery for an Agent that is not running: consumed → ACK and drop; a pending
 * server Start → held unacknowledged in the Start buffer; a runtime-error offline record → the
 * daemon keeps custody (queued and ACKed, `inactive` + Activity restated); a relaunch config →
 * kept for the wake or the wake cooldown; otherwise rejected `no_process` so the server decides
 * whether to start it. Also owns the next-launch custody primitives (`keepForNextLaunch`,
 * `keepInputDeliveriesForNextLaunch`) the wake and offline paths share.
 */
export class AgentExitedDelivery {
  readonly #ports: AgentExitedDeliveryPorts;
  readonly #startBuffers = new Map<string, AgentMessageDelivery[]>();
  /** The wake each Agent waits on until its launch-failure cooldown ends: cancels it. */
  readonly #cooldownWakes = new Map<string, () => void>();

  constructor(ports: AgentExitedDeliveryPorts) {
    this.#ports = ports;
  }

  /**
   * A tracked @mention for an Agent with no process and no launch in flight. It is kept against the
   * launch and session the Agent last reported and wakes the Agent, as an ordinary delivery does,
   * the launch it starts telling the mention once. A wake that fails refuses it. Under a retryable
   * runtime-error backoff it is kept the same way but wakes nobody: the Agent would only fail again,
   * so `backoffEnded` wakes it when the backoff is over (a Stop, a purge, the Daemon stopping, an
   * offline-taking failure or a failed launch refuses it first). With no identity to keep it for
   * (stopped by a person, taken offline, never launched here, held by a tripped fence) it is
   * refused as unknown.
   */
  deliverMention(message: TrackedMentionDelivery): void {
    const { agentId } = message;
    const restart = this.#ports.restartConfig(agentId);
    const held = this.#ports.hasRuntimeErrorHold(agentId);
    if (
      !restart ||
      this.#ports.offline.has(agentId) ||
      (held && !this.#ports.backoffHeld(agentId))
    ) {
      this.#ports.dropMentionAsUnknown(message);
      return;
    }
    if (!this.#ports.keepMention(message) || held) return;
    if (this.#ports.wakeBlockedUntil(agentId) !== undefined) this.#wakeAfterCooldown(agentId);
    else this.#wakeForKept(agentId, restart);
  }

  /** The Agent's runtime-error backoff ran its course. Mentions kept through it, which waited for
   * the Agent to be able to run again, wake it now (after a launch-failure cooldown, when one
   * runs); with nothing left to relaunch from they are refused as unknown. A running or coming
   * launch tells them already. */
  backoffEnded(agentId: string): void {
    if (!this.#ports.hasKeptMentions(agentId) || this.#ports.launchComing(agentId)) return;
    const restart = this.#ports.restartConfig(agentId);
    if (!restart)
      this.#ports.refuseKeptMentions(agentId, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN);
    else if (this.#ports.wakeBlockedUntil(agentId) !== undefined) this.#wakeAfterCooldown(agentId);
    else this.#wakeForKept(agentId, restart);
  }

  #wakeForKept(agentId: string, restart: AgentRestartConfig): void {
    // A launch that fails refuses the mentions kept for it (`startAgent`); the cooldown it starts
    // is waited out for whatever still waits.
    this.#ports.wakeAgent(agentId, restart).catch(() => this.#wakeAfterCooldown(agentId));
  }

  /** No launch is coming for the tracked @mentions kept for the Agent: each is refused with `code`. */
  refuseKept(agentId: string, code: MentionDeliveryTerminalCode): void {
    this.#ports.refuseKeptMentions(agentId, code);
  }

  /** Whatever waits for the Agent's next launch is not left waiting for a delivery to come: one
   * wake is armed for the instant its launch-failure cooldown ends, when anything still waits. A
   * cooldown extended meanwhile is waited out again; a cancellation drops the wake. */
  #wakeAfterCooldown(agentId: string): void {
    const until = this.#ports.wakeBlockedUntil(agentId);
    if (until === undefined || this.#cooldownWakes.has(agentId)) return;
    this.#cooldownWakes.set(
      agentId,
      scheduleUnrefTimer(
        async () => {
          this.#cooldownWakes.delete(agentId);
          const restart = this.#ports.restartConfig(agentId);
          if (!restart || this.#ports.launchComing(agentId)) return;
          if (this.#ports.wakeBlockedUntil(agentId) !== undefined)
            return this.#wakeAfterCooldown(agentId);
          if (this.#ports.hasQueued(agentId) || this.#ports.hasKeptMentions(agentId))
            this.#wakeForKept(agentId, restart);
        },
        Math.max(1, until - Date.now()),
      ),
    );
    this.#ports.whenCancelled(agentId, () => {
      this.#cooldownWakes.get(agentId)?.();
      this.#cooldownWakes.delete(agentId);
    });
  }

  /** A delivery for an Agent with no hold, session, or launch in flight. */
  async deliver(message: AgentMessageDelivery): Promise<void> {
    if (this.#ports.hasRuntimeErrorHold(message.agentId)) {
      await this.#ports.holdRuntimeErrorDelivery(message);
      return;
    }
    // An exited Agent is not woken for a message it has already consumed: the delivery is
    // acknowledged and dropped here, before any launch, rather than after one.
    if (this.#ports.hasConsumed(message)) {
      this.#ports.logConsumed(message);
      return this.#ports.acknowledge(message);
    }
    const restart = this.#ports.restartConfig(message.agentId);
    if (!restart && this.#ports.startPending(message.agentId))
      return this.#holdForPendingStart(message);
    // A runtime error took this Agent offline: the daemon keeps custody of its deliveries
    // (queued for the next launch, acknowledged now) — it never launches on its own, and a
    // wake launch would fail the same way the last one did. The record outlives the restart
    // config: only a person's Start (which reports `active`) or an explicit Stop clears it.
    if (this.#ports.offline.has(message.agentId)) return this.#keepDeliveryForOfflineAgent(message);
    if (!restart) return this.#rejectDeliveriesWithoutProcess(message);
    // A wake launch failed moments ago, so launching again now would most likely fail the same
    // way. The delivery waits, acknowledged as the daemon keeps it, for the first launch after
    // the cooldown.
    const blockedUntil = this.#ports.wakeBlockedUntil(message.agentId);
    if (blockedUntil !== undefined) {
      this.keepForNextLaunch(message.agentId, message);
      this.#wakeAfterCooldown(message.agentId);
      logger.info("Agent wake deferred by a launch-failure cooldown", {
        event: "agent.wake.cooldown_deferred",
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        until: new Date(blockedUntil).toISOString(),
      });
      return;
    }
    // Deliveries are already waiting for this Agent's next launch: this one joins them, so the
    // launch presents all of them in a single notice instead of this one alone.
    if (this.#ports.hasQueued(message.agentId)) {
      this.keepForNextLaunch(message.agentId, message);
      await this.#ports.wakeAgent(message.agentId, restart);
      return;
    }
    const delivery = this.#ports.enqueueInputDelivery(message.agentId, message);
    await Promise.all([this.#ports.wakeAgent(message.agentId, restart), delivery]);
  }

  /**
   * A server Start is pending (being set up, or waiting out a launch-retry cooldown) for an
   * Agent with nothing else to take this delivery. It is held for that Start without an ACK:
   * the daemon takes custody only once the Agent can be told.
   */
  #holdForPendingStart(message: AgentMessageDelivery): void {
    const held = this.#startBuffers.get(message.agentId) ?? [];
    held.push(message);
    this.#startBuffers.set(message.agentId, held);
    logger.info("Agent delivery held for a pending Start", {
      event: "agent.message.delivery_held_for_start",
      agent_id: message.agentId,
      delivery_id: message.deliveryId,
      held_count: held.length,
    });
  }

  /** The pending Start settled: a launched Agent receives what was held as ordinary deliveries;
   * otherwise it is dropped unacknowledged and stays unread in the cloud. */
  releaseStartBuffer(agentId: string): void {
    const held = this.#startBuffers.get(agentId);
    if (!held) return;
    this.#startBuffers.delete(agentId);
    if (!this.#ports.hasSession(agentId)) {
      logger.info("Agent deliveries held for a Start that did not launch were dropped", {
        event: "agent.message.start_buffer_dropped",
        agent_id: agentId,
        dropped_count: held.length,
      });
      return;
    }
    for (const message of held) this.#ports.redeliver(message);
  }

  /**
   * An Agent a runtime error took offline keeps custody of its deliveries (terminal residency,
   * as the reference Computer does): each is queued in `AgentDeliveryGate` for the next launch
   * and acknowledged now, with `inactive` and the failure's Activity restated at a fresh
   * clientSeq. The daemon never launches it on its own — a person's Start does.
   */
  #keepDeliveryForOfflineAgent(message: AgentMessageDelivery): void {
    this.keepForNextLaunch(message.agentId, message);
    this.#ports.offline.restate(message.agentId);
  }

  /**
   * No process, no launch in flight, nothing to relaunch from, and no offline record: the daemon
   * takes no custody, so nothing is acknowledged. This delivery, and any a lifted runner hold
   * left queued for the same Agent, are rejected back to the server as `no_process`; the server
   * decides whether to start the Agent.
   */
  async #rejectDeliveriesWithoutProcess(message: AgentMessageDelivery): Promise<void> {
    const queued = this.#ports.queuedInputDeliveries(message.agentId);
    this.#ports.closeAgentInputQueue(message.agentId, new Error("Agent is inactive"));
    this.#ports.sendAgentStatus(message.agentId, "inactive");
    for (const rejected of [...queued, message]) {
      // A tracked mention a lifted runner hold left queued names a launch that is gone.
      if (this.#ports.dropMentionAsUnknown(rejected)) continue;
      logger.info("Agent delivery rejected: no process to take it", {
        event: "agent.message.delivery_rejected",
        agent_id: rejected.agentId,
        delivery_id: rejected.deliveryId,
        reason: "no_process",
      });
      await this.#ports.sendAgentDeliveryRejection(rejected, "no_process");
    }
  }

  /** Keeps a delivery in `AgentDeliveryGate` for the Agent's next launch, acknowledged now: the
   * daemon has taken custody of it, so the server need not resend it. */
  keepForNextLaunch(agentId: string, message: AgentMessageDelivery): void {
    this.#ports.queueForNextLaunch(agentId, message);
    this.#ports.acknowledgeCustody(message);
  }

  /** A failed launch hands the deliveries still waiting in its input queue to
   * `AgentDeliveryGate`, acknowledging each as the daemon keeps it, so the next launch
   * presents them. No launch is coming for a tracked @mention it kept: it is refused with
   * `refusal`. */
  keepInputDeliveriesForNextLaunch(
    agentId: string,
    error: unknown,
    refusal: MentionDeliveryTerminalCode = MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN,
  ): void {
    this.keepDeliveries(agentId, this.#ports.drainInputDeliveries(agentId), error);
    this.#ports.refuseKeptMentions(agentId, refusal);
  }

  /** The same custody for deliveries the caller already took. Any other than a tracked mention is
   * kept for the next launch. A tracked mention is kept for it when `relaunching` (a restart is
   * coming), and otherwise dropped as unknown: it named a launch that never came up. */
  keepDeliveries(
    agentId: string,
    messages: readonly AgentMessageDelivery[],
    error: unknown,
    relaunching = false,
  ): void {
    for (const message of messages) {
      if (
        relaunching ? this.#ports.holdMention(message) : this.#ports.dropMentionAsUnknown(message)
      )
        continue;
      this.keepForNextLaunch(agentId, message);
      logger.info("Agent delivery kept for the next launch after a failed launch", {
        event: "agent.message.delivery_kept",
        agent_id: agentId,
        delivery_id: message.deliveryId,
        error_code: diagnosticErrorName(error),
      });
    }
  }
}
