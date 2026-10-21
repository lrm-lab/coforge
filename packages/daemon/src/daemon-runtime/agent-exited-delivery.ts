import { getLogger } from "@logtape/logtape";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { diagnosticErrorName } from "#src/platform/diagnostic-error-code";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How a delivery is settled for an Agent with no hold, session, or launch in flight. */
export type AgentExitedDeliveryPorts = Readonly<{
  /** A runtime-error backoff that must survive an unexpected process exit. */
  hasRuntimeErrorHold(agentId: string): boolean;
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
  /** Records a delivery in `AgentDeliveryQueue` as waiting for the next launch. */
  queueForNextLaunch(agentId: string, message: AgentMessageDelivery): void;
  /** The wake launch cooldown's end instant, when one is in force. */
  wakeBlockedUntil(agentId: string): number | undefined;
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
  sendAgentStatus(agentId: string, status: "inactive"): void;
  sendAgentDeliveryRejection(message: AgentMessageDelivery, reason: "no_process"): Promise<void>;
  /** The Agent's session is registered (a pending-Start buffer releases only into one). */
  hasSession(agentId: string): boolean;
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

  constructor(ports: AgentExitedDeliveryPorts) {
    this.#ports = ports;
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
    // (queued for the next launch, acknowledged now) — it never launches on its own.
    if (!restart && this.#ports.offline.has(message.agentId))
      return this.#keepDeliveryForOfflineAgent(message);
    if (!restart) return this.#rejectDeliveriesWithoutProcess(message);
    // A wake launch failed moments ago, so launching again now would most likely fail the same
    // way. The delivery waits, acknowledged as the daemon keeps it, for the first launch after
    // the cooldown.
    const blockedUntil = this.#ports.wakeBlockedUntil(message.agentId);
    if (blockedUntil !== undefined) {
      this.keepForNextLaunch(message.agentId, message);
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
   * as the reference Computer does): each is queued in `AgentDeliveryQueue` for the next launch
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

  /** Keeps a delivery in `AgentDeliveryQueue` for the Agent's next launch, acknowledged now: the
   * daemon has taken custody of it, so the server need not resend it. */
  keepForNextLaunch(agentId: string, message: AgentMessageDelivery): void {
    this.#ports.queueForNextLaunch(agentId, message);
    this.#ports.acknowledgeCustody(message);
  }

  /** A failed launch hands the deliveries still waiting in its input queue to
   * `AgentDeliveryQueue`, acknowledging each as the daemon keeps it, so the next launch
   * presents them. */
  keepInputDeliveriesForNextLaunch(agentId: string, error: unknown): void {
    for (const message of this.#ports.drainInputDeliveries(agentId)) {
      // A tracked mention named a launch that never came up; it never waits for the next one.
      if (this.#ports.dropMentionAsUnknown(message)) continue;
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
