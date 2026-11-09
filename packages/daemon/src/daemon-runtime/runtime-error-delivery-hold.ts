import { getLogger } from "@logtape/logtape";
import {
  buildRuntimeErrorActivity,
  fingerprintRuntimeError,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import {
  RUNTIME_ERROR_FENCE_EXEMPT_CLASSES,
  RUNTIME_ERROR_RECOVERY_EFFECTS,
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  RuntimeErrorClassFence,
  type RuntimeErrorClassFenceState,
  type RuntimeErrorFingerprintFenceState,
  type RuntimeErrorRecoverySignal,
} from "#src/agent-runtime/runtime-error-recovery";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";

/** The longest delay one `setTimeout` honours (a signed 32-bit millisecond count). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The durable half of a backoff: what a Daemon restart must find again (the reference
 * Computer's `lifecycleRecords`). */
export type RuntimeErrorBackoffPersistence = Readonly<{
  save(
    agentId: string,
    state: Readonly<{
      untilMs: number;
      reason: "rate_limit_backoff" | "runtime_error_backoff";
      /** Whose failure raised the wait; absent when the caller could not name one. */
      provider?: string;
    }>,
  ): void;
  clear(agentId: string): void;
}>;

export type RuntimeErrorDeliveryHoldPorts = Readonly<{
  /** Owns the explicit hold; this module only decides when it starts and ends. */
  deliveryQueue: Pick<
    AgentDeliveryQueue,
    "hold" | "release" | "endHoldForNextLaunch" | "explicitHold" | "pending"
  >;
  /** Attempts delivery of what a released hold gave back, never blocking the caller. */
  flush(agentId: string, held: AgentMessageDelivery[]): void;
  /** Where a backoff outlives the process; absent when the caller keeps it in memory only. */
  store?: RuntimeErrorBackoffPersistence;
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
const logger = getLogger(["coforge", "daemon", "runtime"]);

export class RuntimeErrorDeliveryHold {
  readonly #ports: RuntimeErrorDeliveryHoldPorts;
  readonly #backoff = new RuntimeErrorDeliveryBackoff();
  readonly #fence = new RuntimeErrorFingerprintFence();
  /** The one release timer per waiting Agent, and the provider whose failure it waits on (absent
   * when none was recorded, which a lifted limit cannot resolve). */
  readonly #releaseTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; provider?: string }
  >();

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
   *
   * A class in `RUNTIME_ERROR_FENCE_EXEMPT_CLASSES` is never fenced and leaves the streak alone:
   * an unreachable provider, its server error and a rate limit are worth retrying for as long as
   * they last (task #726).
   */
  noteFailure(
    agentId: string,
    classification: RuntimeErrorClassification,
    fingerprint: string,
    provider?: string,
  ): RuntimeErrorFingerprintFenceState | undefined {
    const fence = RUNTIME_ERROR_FENCE_EXEMPT_CLASSES.has(classification.errorClass)
      ? undefined
      : this.#fence.note(agentId, fingerprint);
    if (fence?.fenced) {
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
    this.#ports.store?.save(agentId, {
      untilMs: backoff.untilMs,
      reason:
        classification.errorClass === RUNTIME_ERROR_CLASS.RATE_LIMIT
          ? "rate_limit_backoff"
          : "runtime_error_backoff",
      ...(provider ? { provider } : {}),
    });
    this.#scheduleRelease(agentId, backoff.untilMs, provider);
    // One line per step of the wait, so a run of retries is readable from the log alone: which
    // rung this is, how long it waits and how much is queued behind it. Nothing of the messages.
    logger.info("Held deliveries for a retrying runtime", {
      event: "agent.runtime.delivery_held",
      agent_id: agentId,
      error_class: classification.errorClass,
      attempt: backoff.attempts,
      retry_in_ms: backoff.delayMs,
      held: this.#ports.deliveryQueue.pending(agentId).length,
      reason:
        classification.errorClass === RUNTIME_ERROR_CLASS.RATE_LIMIT
          ? "rate_limit_backoff"
          : "runtime_error_backoff",
      outcome: "held",
    });
    return undefined;
  }

  /**
   * Re-arms the backoffs a previous Daemon recorded (the reference Computer's
   * `restoreProviderLimitBackoff`): each still-future wait holds its Agent's deliveries again and
   * keeps the release timer; an already-expired one is dropped. Records whose wait ended while
   * the Daemon was down are not retried from a stale premise.
   */
  restore(
    records: readonly Readonly<{
      agentId: string;
      untilMs: number;
      reason: "rate_limit_backoff" | "runtime_error_backoff";
      provider?: string;
    }>[],
  ): void {
    const now = Date.now();
    for (const record of records) {
      if (record.untilMs <= now) {
        this.#ports.store?.clear(record.agentId);
        continue;
      }
      this.#ports.deliveryQueue.hold(record.agentId, record.reason);
      this.#scheduleRelease(record.agentId, record.untilMs, record.provider);
      // A restarted Daemon says which waits it picked up: the only line that shows a usage limit
      // surviving the process without a live failure to point at.
      logger.info("Runtime backoff restored", {
        event: "agent.runtime.backoff_restored",
        agent_id: record.agentId,
        until_ms: record.untilMs,
        reason: record.reason,
      });
    }
  }

  /** Class state belongs to the launch. Raft calls this runtime_error_class_fence.tripped. */
  noteRuntimeFailure(
    agentId: string,
    launch: { runtimeErrorClassFence?: RuntimeErrorClassFence; provider?: string },
    event: RuntimeErrorEvent,
    classification: RuntimeErrorClassification,
  ): {
    built: ReturnType<typeof buildRuntimeErrorActivity>;
    fence?: (RuntimeErrorFingerprintFenceState | RuntimeErrorClassFenceState) & { event: string };
  } {
    const built = buildRuntimeErrorActivity(event, classification);
    const classFence = (launch.runtimeErrorClassFence ??= new RuntimeErrorClassFence()).note(
      classification,
    );
    const fingerprintFence = this.noteFailure(
      agentId,
      classification,
      built.runtimeError?.fingerprint ?? fingerprintRuntimeError(event.message),
      launch.provider,
    );
    if (fingerprintFence)
      return {
        built,
        fence: { ...fingerprintFence, event: "agent_runtime:fingerprint_fence_tripped" },
      };
    if (!classFence?.fenced) return { built };
    this.#holdFenced(agentId);
    return { built, fence: { ...classFence, event: "agent_runtime:class_fence_tripped" } };
  }

  /** Applies the signal's `RUNTIME_ERROR_RECOVERY_EFFECTS`. With no backoff nothing is released,
   * so deliveries queued for another reason (a launch's batch) stay where they are. */
  noteRecoverySignal(
    agentId: string,
    signal: RuntimeErrorRecoverySignal,
    classFence?: RuntimeErrorClassFence,
  ): void {
    const effects = RUNTIME_ERROR_RECOVERY_EFFECTS[signal];
    if (effects.resetsFence) {
      this.#fence.reset(agentId);
      classFence?.reset();
    }
    if (this.#backoff.attempts(agentId) === 0) return;
    const rateLimited = this.#backoff.latestClass(agentId) === RUNTIME_ERROR_CLASS.RATE_LIMIT;
    if (rateLimited ? effects.endsRateLimitBackoff : effects.endsBackoff) this.#endBackoff(agentId);
  }

  /**
   * `provider`'s limit was just lifted (a reset credit was spent): ends the rate-limit backoff of
   * every Agent whose failure was that provider's, through the path an observed recovery takes,
   * so the persisted record and the release timer go with it. The Agents are the ones this hold
   * recorded a provider for (`noteFailure`, or a restored record that carried one): an Agent
   * restored from a record without a provider cannot be told apart and keeps waiting. An Agent
   * `hasSession` says has a process gets its held deliveries flushed; one without keeps its queue
   * for its next launch, and only its waiting ends. A backoff for any other failure and a tripped
   * fence's hold stay. Returns how many backoffs ended.
   */
  releaseRateLimitBackoffs(provider: string, hasSession: (agentId: string) => boolean): number {
    let released = 0;
    for (const [agentId, waiting] of Array.from(this.#releaseTimers)) {
      if (waiting.provider !== provider) continue;
      if (this.#ports.deliveryQueue.explicitHold(agentId) !== "rate_limit_backoff") continue;
      this.#endBackoff(agentId, hasSession(agentId));
      released += 1;
    }
    return released;
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
    this.#ports.store?.clear(agentId);
  }

  /**
   * The runtime is stopping: every pending backoff ends now instead of when its timer fires, so no
   * timer keeps the stopped process alive and no hold outlives the timer that would have released
   * it. What a backoff held is dropped, not flushed: it was already acknowledged, and the cloud read
   * boundary recovers it on the next Start. The streaks and a fence's hold stay, as before.
   */
  disposeAll(): void {
    for (const [agentId, { timer }] of this.#releaseTimers) {
      clearTimeout(timer);
      this.#ports.deliveryQueue.release(agentId);
    }
    this.#releaseTimers.clear();
  }

  /** Cancels any pending release timer, releases (and flushes) anything currently held under an
   * explicit hold, and forgets the consecutive-retryable-failure streak. A tripped fence keeps its
   * hold instead (see `#holdFenced`): only the streak is forgotten. Leaves the fingerprint fence's
   * own streak to its callers. With `flush` false the hold ends but what it held stays queued,
   * for an Agent that has no process to deliver it to. */
  #endBackoff(agentId: string, flush = true): void {
    this.#clearReleaseTimer(agentId);
    if (!this.#isFenced(agentId)) {
      if (flush) this.#releaseHeld(agentId);
      else this.#ports.deliveryQueue.endHoldForNextLaunch(agentId);
    }
    this.#backoff.reset(agentId);
    this.#ports.store?.clear(agentId);
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
  #scheduleRelease(agentId: string, untilMs: number, provider?: string): void {
    this.#clearReleaseTimer(agentId);
    const remainingMs = untilMs - Date.now();
    const timer = setTimeout(
      () => {
        this.#releaseTimers.delete(agentId);
        if (remainingMs > MAX_TIMER_DELAY_MS) this.#scheduleRelease(agentId, untilMs, provider);
        else {
          this.#releaseHeld(agentId);
          this.#ports.store?.clear(agentId);
        }
      },
      Math.min(Math.max(0, remainingMs), MAX_TIMER_DELAY_MS),
    );
    this.#releaseTimers.set(agentId, { timer, ...(provider ? { provider } : {}) });
  }

  #clearReleaseTimer(agentId: string): void {
    const timer = this.#releaseTimers.get(agentId)?.timer;
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#releaseTimers.delete(agentId);
  }

  #releaseHeld(agentId: string): void {
    const held = this.#ports.deliveryQueue.release(agentId);
    if (held.length) this.#ports.flush(agentId, held);
  }
}
