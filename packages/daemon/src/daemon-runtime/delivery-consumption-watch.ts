import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime", "delivery-consumption"]);
const PENDING_EXPIRY_MS = 30_000;
const TURN_END_GRACE_MS = 250;
const UNCONSUMED_THRESHOLD = 3;

export type DeliveryConsumptionSnapshot = Readonly<{
  launchId: string;
  pendingWrites: number;
  firstPendingAtMs: number | undefined;
  lastDeliveryId: string | undefined;
  warned: boolean;
}>;

type PendingDelivery = {
  deliveryId: string;
  acceptedAtMs: number;
  turnEndedAtMs?: number;
};

type Pending = {
  launchId: string;
  /** ActivityLaunch identity; wake relaunches can reuse server launchId. */
  generation: object;
  entries: Map<string, PendingDelivery>;
  warned: boolean;
};

/**
 * Observes the gap between a delivery being accepted by the daemon and the runtime producing a
 * consumption signal. The input drain registers before `session.notify()` so synchronous provider
 * output cannot race past the watch; failed writes cancel that registration. A turn-end alone is
 * retained as evidence because it may belong to the turn already running for a busy notice.
 */
export class DeliveryConsumptionWatch {
  readonly #pending = new Map<string, Pending>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  recordWrite(
    agentId: string,
    launchId: string,
    generation: object,
    delivery: Pick<AgentMessageDelivery, "deliveryId">,
  ): void {
    const now = this.#now();
    this.#expire(agentId, now);
    let pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId || pending.generation !== generation) {
      pending = { launchId, generation, entries: new Map(), warned: false };
      this.#pending.set(agentId, pending);
    }
    if (pending.entries.has(delivery.deliveryId)) return;
    pending.entries.set(delivery.deliveryId, {
      deliveryId: delivery.deliveryId,
      acceptedAtMs: now,
    });
    if (pending.entries.size < UNCONSUMED_THRESHOLD || pending.warned) return;
    pending.warned = true;
    logger.warn("Agent delivery remains unconsumed", {
      event: "daemon.agent.delivery.consumption",
      agent_id: agentId,
      launch_id: launchId,
      pending_writes: pending.entries.size,
      first_pending_at_ms: pending.entries.values().next().value?.acceptedAtMs,
      last_delivery_id: delivery.deliveryId,
      reason: "delivery_in_flight",
    });
  }

  /** Removes a write that never reached the provider, such as a rejected local delivery. */
  cancelWrite(agentId: string, launchId: string, generation: object, deliveryId: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId || pending.generation !== generation) return;
    pending.entries.delete(deliveryId);
    if (pending.entries.size === 0) this.#pending.delete(agentId);
  }

  observeRuntimeEvent(
    agentId: string,
    launchId: string,
    generation: object,
    event: AgentRuntimeEvent,
  ): void {
    const now = this.#now();
    this.#expire(agentId, now);
    if (event.type === "error") {
      this.recordRuntimeError(agentId, launchId, generation, event.message);
      return;
    }
    if (event.type === "completed") {
      this.#markTurnEnded(agentId, launchId, generation, now);
      return;
    }
    if (
      event.type === "text-delta" ||
      event.type === "thinking-delta" ||
      event.type === "tool-start" ||
      event.type === "tool-output" ||
      event.type === "tool-end"
    )
      this.recordConsumption(agentId, launchId, generation, event.type);
  }

  recordConsumption(agentId: string, launchId: string, generation: object, signal: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId || pending.generation !== generation) return;
    const delivery = pending.entries.values().next().value as PendingDelivery | undefined;
    if (!delivery) return;
    pending.entries.delete(delivery.deliveryId);
    logger.info("Agent delivery consumption observed", {
      event: "daemon.agent.delivery.consumed",
      agent_id: agentId,
      launch_id: launchId,
      delivery_id: delivery.deliveryId,
      signal,
    });
    if (pending.entries.size === 0) this.#pending.delete(agentId);
  }

  recordRuntimeError(agentId: string, launchId: string, generation: object, detail: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId || pending.generation !== generation) return;
    const delivery = pending.entries.values().next().value as PendingDelivery | undefined;
    if (!delivery) return;
    pending.entries.delete(delivery.deliveryId);
    logger.warn("Agent delivery consumption ended with runtime error", {
      event: "daemon.agent.delivery.consumption_error",
      agent_id: agentId,
      launch_id: launchId,
      delivery_id: delivery.deliveryId,
      pending_writes: pending.entries.size + 1,
      error_detail: detail.slice(0, 200),
    });
    if (pending.entries.size === 0) this.#pending.delete(agentId);
  }

  snapshot(agentId: string): DeliveryConsumptionSnapshot | undefined {
    this.#expire(agentId, this.#now());
    const pending = this.#pending.get(agentId);
    if (!pending || pending.entries.size === 0) return undefined;
    const entries = [...pending.entries.values()];
    return {
      launchId: pending.launchId,
      pendingWrites: entries.length,
      firstPendingAtMs: entries[0]?.acceptedAtMs,
      lastDeliveryId: entries.at(-1)?.deliveryId,
      warned: pending.warned,
    };
  }

  forget(agentId: string, launchId?: string): void {
    const pending = this.#pending.get(agentId);
    if (pending && (launchId === undefined || pending.launchId === launchId))
      this.#pending.delete(agentId);
  }

  #markTurnEnded(agentId: string, launchId: string, generation: object, atMs: number): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId || pending.generation !== generation) return;
    for (const entry of pending.entries.values()) entry.turnEndedAtMs ??= atMs;
    setTimeout(
      () => this.#expireTurnBoundary(agentId, generation, atMs),
      TURN_END_GRACE_MS,
    ).unref();
  }

  #expireTurnBoundary(agentId: string, generation: object, turnEndedAtMs: number): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.generation !== generation) return;
    for (const [deliveryId, entry] of pending.entries) {
      if (entry.turnEndedAtMs !== turnEndedAtMs) continue;
      pending.entries.delete(deliveryId);
      logger.info("Agent delivery consumption passed a turn boundary", {
        event: "daemon.agent.delivery.turn_end",
        agent_id: agentId,
        launch_id: pending.launchId,
        delivery_id: deliveryId,
        pending_for_ms: Math.max(0, this.#now() - entry.acceptedAtMs),
      });
    }
    if (pending.entries.size === 0) this.#pending.delete(agentId);
  }

  #expire(agentId: string, now: number): void {
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    for (const [deliveryId, entry] of pending.entries) {
      if (entry.turnEndedAtMs !== undefined && now - entry.turnEndedAtMs >= TURN_END_GRACE_MS) {
        pending.entries.delete(deliveryId);
        logger.info("Agent delivery consumption passed a turn boundary", {
          event: "daemon.agent.delivery.turn_end",
          agent_id: agentId,
          launch_id: pending.launchId,
          delivery_id: deliveryId,
          pending_for_ms: Math.max(0, now - entry.acceptedAtMs),
        });
        continue;
      }
      if (now - entry.acceptedAtMs < PENDING_EXPIRY_MS) continue;
      pending.entries.delete(deliveryId);
      logger.warn("Agent delivery consumption observation expired", {
        event: "daemon.agent.delivery.consumption_expired",
        agent_id: agentId,
        launch_id: pending.launchId,
        delivery_id: deliveryId,
        pending_for_ms: Math.max(0, now - entry.acceptedAtMs),
        turn_ended: entry.turnEndedAtMs !== undefined,
      });
    }
    if (pending.entries.size === 0) this.#pending.delete(agentId);
  }
}
