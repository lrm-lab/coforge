import {
  MENTION_DELIVERY_TERMINAL_CODES,
  type MentionDeliveryEnvelope,
  type MentionDeliveryTerminalCode,
} from "@lrm/coforge-sdk/internal";
import type { MentionDeliveryBlock, RunningMentionIdentity } from "./mention-delivery-ports";
import type { TrackedMentionDelivery } from "./mention-delivery-tracker";

export const BLOCKED_CODES: Readonly<Record<MentionDeliveryBlock, MentionDeliveryTerminalCode>> = {
  rate_limit_backoff: MENTION_DELIVERY_TERMINAL_CODES.QUOTA_LIMITED,
  runtime_error_backoff: MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
  fingerprint_fence: MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
  queued_until_idle: MENTION_DELIVERY_TERMINAL_CODES.UNSUPPORTED_DELIVERY_PATH,
};

export type TrackedState = "received" | "pending" | "drained";
export type Tracked = {
  message: TrackedMentionDelivery;
  state: TrackedState;
  /** The session reported that the notice carrying it never reached the model; that notice's
   * redelivery settles it. */
  undelivered?: true;
  /** Kept for a later launch: `waiting` until that launch's input takes it, `queued` until it is
   * told. It was admitted for an earlier process, so telling it checks no identity. */
  carried?: "waiting" | "queued";
  /** A notice of it is being written to the session. */
  inflight?: true;
};

/** Tracked mentions remembered at most, oldest forgotten first. A mention the server issues again
 * after it was forgotten is judged afresh, which only repeats a report the server already has. */
export const REMEMBERED_MENTIONS = 4096;

export const namesLaunch = (identity: RunningMentionIdentity, envelope: MentionDeliveryEnvelope) =>
  identity.launchId === envelope.launchId && identity.sessionId === envelope.sessionId;

/** The tracker's memory of the mentions it has accepted, by delivery id. */
export class MentionEntries {
  readonly #tracked = new Map<string, Tracked>();
  /** Delivery ids pending per Agent: told during a turn that has not ended. */
  readonly #pending = new Map<string, Set<string>>();
  /** Delivery ids carried per Agent: kept for its next launch. */
  readonly #carried = new Map<string, Set<string>>();

  get(deliveryId: string): Tracked | undefined {
    return this.#tracked.get(deliveryId);
  }

  /** A snapshot, safe to settle entries while walking it. */
  all(): Tracked[] {
    return [...this.#tracked.values()];
  }

  /** Whether any mention of the Agent is unsettled: received, pending or kept for a launch. */
  hasOpen(agentId: string): boolean {
    for (const { message, state } of this.#tracked.values())
      if (message.agentId === agentId && state !== "drained") return true;
    return false;
  }

  pending(agentId: string): ReadonlySet<string> | undefined {
    return this.#pending.get(agentId);
  }

  /** The Agent's carried entries; a snapshot, safe to settle entries while walking it. */
  carriedOf(agentId: string): Tracked[] {
    const ids = this.#carried.get(agentId);
    return ids ? [...ids].map((deliveryId) => this.#tracked.get(deliveryId)!) : [];
  }

  /** Keeps the entry for its Agent's next launch: `waiting` until that launch's input takes it. */
  carry(entry: Tracked, mode: "waiting" | "queued"): void {
    const { agentId, deliveryId } = entry.message;
    entry.carried = mode;
    this.#carried.set(agentId, (this.#carried.get(agentId) ?? new Set()).add(deliveryId));
  }

  /** The entry is no longer kept for a launch. */
  uncarry(entry: Tracked): void {
    delete entry.carried;
    this.#uncarried(entry.message.agentId, entry.message.deliveryId);
  }

  /** Records the mention in `state`, as a new entry. */
  set(message: TrackedMentionDelivery, state: TrackedState): void {
    const { deliveryId, agentId } = message;
    const previous = this.#tracked.get(deliveryId);
    if (!previous && this.#tracked.size >= REMEMBERED_MENTIONS)
      this.forget(this.#tracked.keys().next().value!);
    this.#tracked.delete(deliveryId);
    this.#uncarried(agentId, deliveryId);
    this.#tracked.set(deliveryId, {
      message,
      state,
      ...(previous?.undelivered && state !== "drained" ? { undelivered: true } : {}),
    });
    if (state === "pending")
      this.#pending.set(agentId, (this.#pending.get(agentId) ?? new Set()).add(deliveryId));
    else this.unpend(agentId, deliveryId);
  }

  forget(deliveryId: string): void {
    const tracked = this.#tracked.get(deliveryId);
    if (!tracked) return;
    this.#tracked.delete(deliveryId);
    this.unpend(tracked.message.agentId, deliveryId);
    this.#uncarried(tracked.message.agentId, deliveryId);
  }

  /** Takes the mention out of the pending set. */
  unpend(agentId: string, deliveryId: string): void {
    const pending = this.#pending.get(agentId);
    if (pending?.delete(deliveryId) && pending.size === 0) this.#pending.delete(agentId);
  }

  #uncarried(agentId: string, deliveryId: string): void {
    const carried = this.#carried.get(agentId);
    if (carried?.delete(deliveryId) && carried.size === 0) this.#carried.delete(agentId);
  }
}
