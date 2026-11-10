import type { MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";
import type { RunningMentionIdentity } from "./mention-delivery-ports";
import type { TrackedMentionDelivery } from "./mention-delivery-tracker";

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

  get(deliveryId: string): Tracked | undefined {
    return this.#tracked.get(deliveryId);
  }

  /** A snapshot, safe to settle entries while walking it. */
  all(): Tracked[] {
    return [...this.#tracked.values()];
  }

  pending(agentId: string): ReadonlySet<string> | undefined {
    return this.#pending.get(agentId);
  }

  /** Records the mention in `state`, as a new entry. */
  set(message: TrackedMentionDelivery, state: TrackedState): void {
    const { deliveryId, agentId } = message;
    const previous = this.#tracked.get(deliveryId);
    if (!previous && this.#tracked.size >= REMEMBERED_MENTIONS)
      this.forget(this.#tracked.keys().next().value!);
    this.#tracked.delete(deliveryId);
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
  }

  /** Takes the mention out of the pending set. */
  unpend(agentId: string, deliveryId: string): void {
    const pending = this.#pending.get(agentId);
    if (pending?.delete(deliveryId) && pending.size === 0) this.#pending.delete(agentId);
  }
}
