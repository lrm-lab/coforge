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

/** A notice the daemon wrote that a turn boundary passed without the model consuming it. */
export type UnconsumedNotice = Readonly<{ deliveryIds: readonly string[]; text: string }>;

type PendingDelivery = {
  deliveryId: string;
  acceptedAtMs: number;
  turnEndedAtMs?: number;
  /** The notice text the daemon wrote for this write, once it knows it. */
  text?: string;
};

type Pending = {
  launchId: string;
  /** ActivityLaunch identity; wake relaunches can reuse server launchId. */
  generation: object;
  entries: Map<string, PendingDelivery>;
  warned: boolean;
};

/** How the watch reaches the runtime that can write a notice again. */
export type DeliveryConsumptionWatchOptions = Readonly<{
  now?: () => number;
  reoffer?: (agentId: string, notices: readonly UnconsumedNotice[]) => void;
}>;

/**
 * Observes the gap between a delivery being accepted by the daemon and the runtime producing a
 * consumption signal. The input drain registers before `session.notify()` so synchronous provider
 * output cannot race past the watch; failed writes cancel that registration. A turn-end alone is
 * retained as evidence because it may belong to the turn already running for a busy notice.
 *
 * Acceptance is not consumption: `session.notify()` resolving means the notice was written into
 * the process, which is all a `steer` provider promises. A notice written as a turn ends belongs to
 * the turn that is finishing, so nothing starts a turn for it and no later frame reads it — and the
 * delivery's ACK has already gone out. A write that reaches a turn boundary unconsumed therefore
 * has its notice written again once, as this module's `reoffer` port asks the runtime for (see
 * `UnconsumedNotice`), and then stops being watched: the stalled-recovery watchdog takes over.
 */
export class DeliveryConsumptionWatch {
  readonly #pending = new Map<string, Pending>();
  readonly #now: () => number;
  /** Installed by the composition root that owns the Agent's inbox, once it exists. */
  #reoffer?: (agentId: string, notices: readonly UnconsumedNotice[]) => void;

  constructor(options: DeliveryConsumptionWatchOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#reoffer = options.reoffer;
  }

  /** Where a boundary-crossing write goes to be written again. */
  reofferTo(reoffer: (agentId: string, notices: readonly UnconsumedNotice[]) => void): void {
    this.#reoffer = reoffer;
  }

  recordWrite(
    agentId: string,
    launchId: string,
    generation: object,
    write: Pick<AgentMessageDelivery, "deliveryId"> & { notice?: string },
  ): void {
    const now = this.#now();
    this.#expire(agentId, now);
    let pending = this.#pending.get(agentId);
    if (!pending || pending.launchId !== launchId || pending.generation !== generation) {
      pending = { launchId, generation, entries: new Map(), warned: false };
      this.#pending.set(agentId, pending);
    }
    if (pending.entries.has(write.deliveryId)) return;
    pending.entries.set(write.deliveryId, {
      deliveryId: write.deliveryId,
      acceptedAtMs: now,
      ...(write.notice === undefined ? {} : { text: write.notice }),
    });
    if (pending.entries.size < UNCONSUMED_THRESHOLD || pending.warned) return;
    pending.warned = true;
    logger.warn("Agent delivery remains unconsumed", {
      event: "daemon.agent.delivery.consumption",
      agent_id: agentId,
      launch_id: launchId,
      pending_writes: pending.entries.size,
      first_pending_at_ms: pending.entries.values().next().value?.acceptedAtMs,
      last_delivery_id: write.deliveryId,
      reason: "delivery_in_flight",
    });
  }

  /**
   * The notice text the daemon wrote for these writes (`AgentMessageAttentionIndex` composes it),
   * so a boundary that finds them unconsumed can write it again word for word.
   */
  recordNotice(agentId: string, deliveryIds: readonly string[], text: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    for (const deliveryId of deliveryIds) {
      const entry = pending.entries.get(deliveryId);
      if (entry) entry.text = text;
    }
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
    const reoffer: UnconsumedNotice[] = [];
    const now = this.#now();
    for (const [deliveryId, entry] of pending.entries) {
      if (entry.turnEndedAtMs !== turnEndedAtMs) continue;
      const notice = this.#crossBoundary(pending, agentId, deliveryId, entry, now);
      if (notice) reoffer.push(notice);
    }
    if (pending.entries.size === 0) this.#pending.delete(agentId);
    this.#writeAgain(agentId, reoffer);
  }

  #expire(agentId: string, now: number): void {
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    const reoffer: UnconsumedNotice[] = [];
    for (const [deliveryId, entry] of pending.entries) {
      if (entry.turnEndedAtMs !== undefined && now - entry.turnEndedAtMs >= TURN_END_GRACE_MS) {
        const notice = this.#crossBoundary(pending, agentId, deliveryId, entry, now);
        if (notice) reoffer.push(notice);
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
    this.#writeAgain(agentId, reoffer);
  }

  /**
   * One write reached a turn boundary unconsumed. Its notice text, when the daemon knows it, is
   * written again (the words, not the message) and the write stops being watched: a second offer
   * would need a second delivery, so the stalled-recovery watchdog takes the Agent from there.
   * Without text there is nothing to write, and the crossing is only logged.
   */
  #crossBoundary(
    pending: Pending,
    agentId: string,
    deliveryId: string,
    entry: PendingDelivery,
    now: number,
  ): UnconsumedNotice | undefined {
    pending.entries.delete(deliveryId);
    const fields = {
      event: "daemon.agent.delivery.turn_end",
      agent_id: agentId,
      launch_id: pending.launchId,
      delivery_id: deliveryId,
      pending_for_ms: Math.max(0, now - entry.acceptedAtMs),
      outcome: entry.text === undefined ? "no_notice_text" : "reoffered",
    };
    if (entry.text === undefined) {
      logger.info("Agent delivery passed a turn boundary unconsumed", fields);
      return undefined;
    }
    logger.warn(
      "Agent delivery passed a turn boundary unconsumed; its notice is written again",
      fields,
    );
    return { deliveryIds: [deliveryId], text: entry.text };
  }

  #writeAgain(agentId: string, notices: readonly UnconsumedNotice[]): void {
    if (!notices.length || !this.#reoffer) return;
    try {
      this.#reoffer(agentId, notices);
    } catch (error) {
      logger.warn("An unconsumed notice could not be written again", {
        event: "daemon.agent.delivery.reoffer_failed",
        agent_id: agentId,
        delivery_ids: notices.flatMap((notice) => notice.deliveryIds),
        error_code: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
