import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime", "delivery-consumption"]);

const UNCONSUMED_THRESHOLD = 3;

export type DeliveryConsumptionSnapshot = Readonly<{
  launchId: string;
  pendingWrites: number;
  firstPendingAtMs: number | undefined;
  lastDeliveryId: string | undefined;
  warned: boolean;
}>;

type Pending = {
  launchId: string;
  pendingWrites: number;
  firstPendingAtMs?: number;
  lastDeliveryId?: string;
  warned: boolean;
};

/**
 * Observes the gap between a delivery being accepted by the daemon and the runtime producing a
 * consumption signal. This is deliberately daemon-local: it does not change ACKs, Activity, or
 * restart behavior until the signal mapping has been proven across providers.
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
    delivery: Pick<AgentMessageDelivery, "deliveryId">,
  ): void {
    let pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId) {
      pending = { launchId, pendingWrites: 0, warned: false };
      this.#pending.set(agentId, pending);
    }
    pending.pendingWrites += 1;
    pending.firstPendingAtMs ??= this.#now();
    pending.lastDeliveryId = delivery.deliveryId;
    if (pending.pendingWrites < UNCONSUMED_THRESHOLD || pending.warned) return;
    pending.warned = true;
    logger.warn("Agent delivery remains unconsumed", {
      event: "daemon.agent.delivery.consumption",
      agent_id: agentId,
      launch_id: launchId,
      pending_writes: pending.pendingWrites,
      first_pending_at_ms: pending.firstPendingAtMs,
      last_delivery_id: pending.lastDeliveryId,
      reason: "delivery_in_flight",
    });
  }

  observeRuntimeEvent(agentId: string, launchId: string, event: AgentRuntimeEvent): void {
    if (event.type === "error") {
      this.recordRuntimeError(agentId, launchId, event.message);
      return;
    }
    if (
      event.type === "text-delta" ||
      event.type === "thinking-delta" ||
      event.type === "tool-start" ||
      event.type === "tool-output" ||
      event.type === "tool-end" ||
      event.type === "completed"
    )
      this.recordConsumption(agentId, launchId, event.type);
  }

  recordConsumption(agentId: string, launchId: string, signal: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId) return;
    this.#pending.delete(agentId);
    logger.info("Agent delivery consumption observed", {
      event: "daemon.agent.delivery.consumed",
      agent_id: agentId,
      launch_id: launchId,
      signal,
    });
  }

  recordRuntimeError(agentId: string, launchId: string, detail: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId) return;
    this.#pending.delete(agentId);
    logger.warn("Agent delivery consumption ended with runtime error", {
      event: "daemon.agent.delivery.consumption_error",
      agent_id: agentId,
      launch_id: launchId,
      pending_writes: pending.pendingWrites,
      error_detail: detail.slice(0, 200),
    });
  }

  snapshot(agentId: string): DeliveryConsumptionSnapshot | undefined {
    const pending = this.#pending.get(agentId);
    return (
      pending && {
        launchId: pending.launchId,
        pendingWrites: pending.pendingWrites,
        firstPendingAtMs: pending.firstPendingAtMs,
        lastDeliveryId: pending.lastDeliveryId,
        warned: pending.warned,
      }
    );
  }

  forget(agentId: string, launchId?: string): void {
    const pending = this.#pending.get(agentId);
    if (pending && (launchId === undefined || pending.launchId === launchId))
      this.#pending.delete(agentId);
  }
}
