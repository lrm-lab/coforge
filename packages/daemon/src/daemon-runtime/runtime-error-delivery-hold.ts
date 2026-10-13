import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import {
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  type RuntimeErrorFingerprintFenceState,
} from "#src/agent-runtime/runtime-error-recovery";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";

export type RuntimeErrorDeliveryHoldPorts = Readonly<{
  /** Owns the explicit hold; this module only decides when it starts and ends. */
  deliveryQueue: Pick<AgentDeliveryQueue, "hold" | "release">;
  /** Attempts delivery of what a released hold gave back, never blocking the caller. */
  flush(agentId: string, held: AgentMessageDelivery[]): void;
}>;

/**
 * Turns an Agent's mid-turn runtime errors into its delivery hold: the consecutive-failure
 * backoff, the same-fingerprint repeat fence (both streaks in
 * `agent-runtime/runtime-error-recovery.ts`), and the one release timer per Agent that ends a
 * backoff. `AgentDeliveryQueue` records that the Agent is held and why; the release timer here is
 * the single owner of when a backoff ends.
 */
export class RuntimeErrorDeliveryHold {
  readonly #ports: RuntimeErrorDeliveryHoldPorts;
  readonly #backoff = new RuntimeErrorDeliveryBackoff();
  readonly #fence = new RuntimeErrorFingerprintFence();
  readonly #releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(ports: RuntimeErrorDeliveryHoldPorts) {
    this.#ports = ports;
  }

  /**
   * Records one runtime error. A failure not worth retrying ends any backoff instead of holding
   * deliveries behind one that will never usefully resolve. A retryable one holds deliveries for
   * the next backoff delay, unless its fingerprint has now repeated enough to trip the fence: the
   * tripped fence's state is returned so the caller can word its Activity.
   */
  noteFailure(
    agentId: string,
    classification: RuntimeErrorClassification,
    fingerprint: string,
  ): RuntimeErrorFingerprintFenceState | undefined {
    if (classification.retryDecision !== RUNTIME_ERROR_RETRY_DECISION.RETRY) {
      this.#endBackoff(agentId);
      return undefined;
    }
    const fence = this.#fence.note(agentId, fingerprint);
    if (fence.fenced) {
      this.#holdFenced(agentId);
      return fence;
    }
    const backoff = this.#backoff.recordFailure(agentId);
    this.#ports.deliveryQueue.hold(
      agentId,
      classification.errorClass === RUNTIME_ERROR_CLASS.RATE_LIMIT
        ? "rate_limit_backoff"
        : "runtime_error_backoff",
    );
    this.#scheduleRelease(agentId, backoff.delayMs);
    return undefined;
  }

  /** A genuinely successful turn: forgets both streaks entirely. A failed or interrupted turn is
   * not one, so a still-active backoff keeps holding across it. */
  noteSuccess(agentId: string): void {
    this.#endBackoff(agentId);
    this.#fence.reset(agentId);
  }

  /** An explicit Stop: a fresh start must not inherit a backoff or fence from a process that no
   * longer exists. The delivery queue's own `clearAgent` drops the hold and what it held. */
  forget(agentId: string): void {
    this.#clearReleaseTimer(agentId);
    this.#backoff.reset(agentId);
    this.#fence.reset(agentId);
  }

  /**
   * The runtime is stopping: every pending backoff ends now instead of when its timer fires, so no
   * timer keeps the stopped process alive and no hold outlives the timer that would have released
   * it. What a backoff held is dropped, not flushed: it was already acknowledged, and the cloud read
   * boundary recovers it on the next Start. The streaks and a fence's hold stay, as before.
   */
  disposeAll(): void {
    for (const [agentId, timer] of this.#releaseTimers) {
      clearTimeout(timer);
      this.#ports.deliveryQueue.release(agentId);
    }
    this.#releaseTimers.clear();
  }

  /** Cancels any pending release timer, releases (and flushes) anything currently held under an
   * explicit hold, and forgets the consecutive-retryable-failure streak. Only for a failure not
   * worth retrying at all, or a successful turn — never for a tripped fingerprint fence, which
   * must keep its hold instead (see `#holdFenced`). Leaves the fingerprint fence's own streak
   * untouched — that one only resets on a successful turn or an explicit Stop, so a fenced Agent
   * stays fenced across a merely non-retryable failure of a different class. */
  #endBackoff(agentId: string): void {
    this.#clearReleaseTimer(agentId);
    this.#releaseHeld(agentId);
    this.#backoff.reset(agentId);
  }

  /**
   * A tripped fingerprint fence stops retrying — cancels any pending release timer and keeps (or
   * starts) an indefinite explicit hold, so nothing currently held, and nothing newly queued,
   * reaches the runtime that just failed the same way three times in a row. Never releases or
   * flushes anything already held: doing so would deliver straight into the same broken runtime
   * this fence exists to stop retrying. Only an explicit Stop clears the hold; an unexpected exit
   * and any relaunch that follows inherit it unchanged.
   */
  #holdFenced(agentId: string): void {
    this.#clearReleaseTimer(agentId);
    this.#ports.deliveryQueue.hold(agentId, "fingerprint_fence");
  }

  #scheduleRelease(agentId: string, delayMs: number): void {
    this.#clearReleaseTimer(agentId);
    const timer = setTimeout(() => {
      this.#releaseTimers.delete(agentId);
      this.#releaseHeld(agentId);
    }, delayMs);
    this.#releaseTimers.set(agentId, timer);
  }

  #clearReleaseTimer(agentId: string): void {
    const timer = this.#releaseTimers.get(agentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#releaseTimers.delete(agentId);
  }

  #releaseHeld(agentId: string): void {
    const held = this.#ports.deliveryQueue.release(agentId);
    if (held.length) this.#ports.flush(agentId, held);
  }
}
