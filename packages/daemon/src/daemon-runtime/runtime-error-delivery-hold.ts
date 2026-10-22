import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import {
  RUNTIME_ERROR_RECOVERY_EFFECTS,
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  type RuntimeErrorFingerprintFenceState,
  type RuntimeErrorRecoverySignal,
} from "#src/agent-runtime/runtime-error-recovery";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";

/** The longest delay one `setTimeout` honours (a signed 32-bit millisecond count). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export type RuntimeErrorDeliveryHoldPorts = Readonly<{
  /** Owns the explicit hold; this module only decides when it starts and ends. */
  deliveryQueue: Pick<AgentDeliveryQueue, "hold" | "release" | "explicitHold">;
  /** Attempts delivery of what a released hold gave back, never blocking the caller. */
  flush(agentId: string, held: AgentMessageDelivery[]): void;
}>;

/**
 * Turns an Agent's mid-turn runtime errors into its delivery hold: the consecutive-failure
 * backoff, the same-fingerprint repeat fence (both streaks in
 * `agent-runtime/runtime-error-recovery.ts`), and the one release timer per Agent that ends a
 * backoff. `AgentDeliveryQueue` records that the Agent is held and why; the release timer here is
 * the single owner of when a backoff ends.
 *
 * What the runtime does next ends them, per the reference behaviour cited at
 * `runtimeErrorRecoverySignal`. A turn end resets the fence's streak, so the fence trips only for
 * the same failure repeating with no turn end or output in between; a usage limit ending every
 * turn never trips it. A tripped fence takes the Agent offline: `runtime.ts` ends the process,
 * and the hold is then cleared via the delivery queue's `clearAgent` and this hold's `forget`.
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
   * Records one runtime error. Every failure reaching this point counts toward the fingerprint
   * fence — matching the reference Computer, which fences any non-offline repeat: a terminal
   * failure that is not worth retrying ends any backoff instead of holding deliveries behind
   * one that will never usefully resolve, and a retryable one holds deliveries for the next
   * backoff delay — unless its fingerprint has now repeated enough to trip the fence, whatever
   * its class. Returns the fence state on a trip so the caller takes the Agent offline with the
   * fence Activity that names what stopped retrying.
   */
  noteFailure(
    agentId: string,
    classification: RuntimeErrorClassification,
    fingerprint: string,
  ): RuntimeErrorFingerprintFenceState | undefined {
    const fence = this.#fence.note(agentId, fingerprint);
    if (fence.fenced) {
      this.#holdFenced(agentId);
      return fence;
    }
    if (classification.retryDecision !== RUNTIME_ERROR_RETRY_DECISION.RETRY) {
      this.#endBackoff(agentId);
      return undefined;
    }
    const backoff = this.#backoff.recordFailure(
      agentId,
      classification.errorClass,
      Date.now(),
      classification.retryNotBefore,
    );
    this.#ports.deliveryQueue.hold(
      agentId,
      classification.errorClass === RUNTIME_ERROR_CLASS.RATE_LIMIT
        ? "rate_limit_backoff"
        : "runtime_error_backoff",
    );
    this.#scheduleRelease(agentId, backoff.untilMs);
    return undefined;
  }

  /** Applies the signal's `RUNTIME_ERROR_RECOVERY_EFFECTS`. With no backoff nothing is released,
   * so deliveries queued for another reason (a launch's batch) stay where they are. */
  noteRecoverySignal(agentId: string, signal: RuntimeErrorRecoverySignal): void {
    const effects = RUNTIME_ERROR_RECOVERY_EFFECTS[signal];
    if (effects.resetsFence) this.#fence.reset(agentId);
    if (this.#backoff.attempts(agentId) === 0) return;
    const rateLimited = this.#backoff.latestClass(agentId) === RUNTIME_ERROR_CLASS.RATE_LIMIT;
    if (rateLimited ? effects.endsRateLimitBackoff : effects.endsBackoff) this.#endBackoff(agentId);
  }

  /** A turn ended, whatever its status. It ends only an unclassified failure's backoff: a
   * classified one (a rate limit, a provider connection or server error) has a real delay to
   * honour, and a successful turn with no output ends it no more than a failed one does. */
  noteTurnEnd(agentId: string): void {
    this.#fence.reset(agentId);
    if (this.#backoff.latestClass(agentId) === RUNTIME_ERROR_CLASS.RUNTIME)
      this.#endBackoff(agentId);
  }

  /** An explicit Stop or an offline-taking failure: a fresh start must not inherit a backoff or
   * fence from a process that no longer exists. The delivery queue's own `clearAgent`, called
   * first, drops the hold (the fence's included) and what it held. */
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
   * explicit hold, and forgets the consecutive-retryable-failure streak. A tripped fence keeps its
   * hold instead (see `#holdFenced`): only the streak is forgotten. Leaves the fingerprint fence's
   * own streak to its callers. */
  #endBackoff(agentId: string): void {
    this.#clearReleaseTimer(agentId);
    if (!this.#isFenced(agentId)) this.#releaseHeld(agentId);
    this.#backoff.reset(agentId);
  }

  /**
   * A tripped fingerprint fence stops retrying — cancels any pending release timer and keeps (or
   * starts) an explicit hold, so nothing currently held, and nothing newly queued, reaches the
   * runtime that just failed the same way three times in a row while its process is ending.
   * Never releases or flushes anything already held: doing so would deliver straight into the
   * same broken runtime this fence exists to stop retrying. The trip itself takes the Agent
   * offline (`runtime.ts` ends the process); the hold is then cleared by the delivery queue's
   * `clearAgent` and this hold's `forget`, as an explicit Stop's is.
   */
  #holdFenced(agentId: string): void {
    this.#clearReleaseTimer(agentId);
    this.#ports.deliveryQueue.hold(agentId, "fingerprint_fence");
  }

  #isFenced(agentId: string): boolean {
    return this.#ports.deliveryQueue.explicitHold(agentId) === "fingerprint_fence";
  }

  /** Releases the hold at `untilMs`. A wait longer than one timer can run (a quota reset days
   * away) re-arms until then: a longer timer delay fires at once. */
  #scheduleRelease(agentId: string, untilMs: number): void {
    this.#clearReleaseTimer(agentId);
    const remainingMs = untilMs - Date.now();
    const timer = setTimeout(
      () => {
        this.#releaseTimers.delete(agentId);
        if (remainingMs > MAX_TIMER_DELAY_MS) this.#scheduleRelease(agentId, untilMs);
        else this.#releaseHeld(agentId);
      },
      Math.min(Math.max(0, remainingMs), MAX_TIMER_DELAY_MS),
    );
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
