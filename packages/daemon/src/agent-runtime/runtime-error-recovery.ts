import type { AgentRuntimeEvent } from "@coforge/agent";
import type { RuntimeErrorClass } from "./runtime-error-classification";
import { PHASE_EDGES } from "./runtime-phases";

/**
 * Per-Agent bookkeeping for a retryable runtime error observed mid-turn (a provider's `error`
 * event whose classified retry decision is `retry` — see `runtime-error-classification.ts`).
 * This is deliberately not about spawn failures: `agent-runtime/launch-failure-backoff.ts`
 * already owns the cooldown before a *launch* attempt even reaches a running process; this
 * module only starts once a process is up and a turn fails.
 *
 * Pure bookkeeping on purpose, matching `LaunchFailureBackoff`'s shape: no timers, no I/O. The
 * caller (`daemon-runtime/runtime-error-delivery-hold.ts`) decides what the computed delay
 * means — releasing `AgentDeliveryQueue`'s explicit hold — and owns the actual timer.
 *
 * Two independent streaks live here; the caller decides which runtime events reset each one
 * (`runtimeErrorRecoverySignal` below names what a raw event signals):
 * - `RuntimeErrorDeliveryBackoff` counts consecutive retryable failures for an Agent, regardless
 *   of which failure text caused each one, and computes the exponential/jittered delay before the
 *   next held delivery is released.
 * - `RuntimeErrorFingerprintFence` counts consecutive failures that carry the *same* fingerprint
 *   (agent-runtime/runtime-error-activity.ts's `fingerprintRuntimeError`). Backing off forever at
 *   the delivery backoff's cap would otherwise retry an Agent whose runtime is stuck on the exact
 *   same failure indefinitely; once the same fingerprint repeats
 *   `RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD` times in a row, with nothing resetting the streak
 *   in between, the caller stops retrying that fingerprint instead of holding forever.
 */

/** First delivery-backoff delay: ten seconds. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS = 10_000;
/** Delivery-backoff ceiling: five minutes. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS = 5 * 60_000;
/** Extra delay added on top of the capped exponential delay, as a fraction of it, drawn from an
 * injectable random source so a computed delay is deterministic in tests. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO = 0.1;
/** Consecutive same-fingerprint failures before the caller stops retrying that fingerprint. */
export const RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD = 3;

export type RuntimeErrorDeliveryBackoffOptions = Readonly<{
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  /** Returns a value in `[0, 1)`; defaults to `Math.random`. Tests inject a fixed source so the
   * computed delay is exact instead of a range. */
  jitterRandom?: () => number;
}>;

/** `base * 2^(attempts - 1)`, capped, plus up to `jitterRatio` of the capped delay. */
export function runtimeErrorDeliveryBackoffDelayMs(
  attempts: number,
  options: RuntimeErrorDeliveryBackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS;
  const jitterRatio = options.jitterRatio ?? RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO;
  const jitterRandom = options.jitterRandom ?? Math.random;
  // Bound the exponent before it overflows a float's exact-integer range; the cap below is
  // reached long before this matters.
  const exponent = Math.min(Math.max(0, attempts - 1), 30);
  const cappedDelayMs = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitterUnit = jitterRandom();
  const boundedJitterUnit = Number.isFinite(jitterUnit) ? Math.max(0, Math.min(1, jitterUnit)) : 0;
  const jitterMs = Math.floor(cappedDelayMs * jitterRatio * boundedJitterUnit);
  return Math.min(maxMs, cappedDelayMs + jitterMs);
}

export type RuntimeErrorDeliveryBackoffState = Readonly<{
  attempts: number;
  delayMs: number;
  untilMs: number;
}>;

export class RuntimeErrorDeliveryBackoff {
  readonly #streaks = new Map<string, { attempts: number; latestClass: RuntimeErrorClass }>();

  constructor(private readonly options: RuntimeErrorDeliveryBackoffOptions = {}) {}

  /** Records one retryable failure for `agentId` and returns the delay the next release owes. */
  recordFailure(
    agentId: string,
    errorClass: RuntimeErrorClass,
    now: number = Date.now(),
  ): RuntimeErrorDeliveryBackoffState {
    const attempts = this.attempts(agentId) + 1;
    this.#streaks.set(agentId, { attempts, latestClass: errorClass });
    const delayMs = runtimeErrorDeliveryBackoffDelayMs(attempts, this.options);
    return { attempts, delayMs, untilMs: now + delayMs };
  }

  /** Clears the streak once the runtime has moved on. Returns how many consecutive failures were
   * cleared, so the caller can narrate a recovery only when there was one. */
  reset(agentId: string): number {
    const attempts = this.attempts(agentId);
    this.#streaks.delete(agentId);
    return attempts;
  }

  attempts(agentId: string): number {
    return this.#streaks.get(agentId)?.attempts ?? 0;
  }

  /** The class of the latest failure in the Agent's current streak, or undefined with none. */
  latestClass(agentId: string): RuntimeErrorClass | undefined {
    return this.#streaks.get(agentId)?.latestClass;
  }

  clear(): void {
    this.#streaks.clear();
  }
}

export type RuntimeErrorFingerprintFenceState = Readonly<{
  fingerprint: string;
  attempts: number;
  fenced: boolean;
}>;

export class RuntimeErrorFingerprintFence {
  readonly #state = new Map<string, { fingerprint: string; attempts: number }>();

  /** Consecutive same-fingerprint failures that trip the fence: the count a tripped fence
   * stopped retrying after. */
  constructor(readonly threshold: number = RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD) {}

  /** Records one retryable failure carrying `fingerprint` for `agentId`. A fingerprint different
   * from the one last seen restarts the streak at one, matching a brand-new problem rather than a
   * repeat of the last one. */
  note(agentId: string, fingerprint: string): RuntimeErrorFingerprintFenceState {
    const existing = this.#state.get(agentId);
    const attempts = existing && existing.fingerprint === fingerprint ? existing.attempts + 1 : 1;
    this.#state.set(agentId, { fingerprint, attempts });
    return { fingerprint, attempts, fenced: attempts >= this.threshold };
  }

  /** Clears the streak once the runtime has moved on. */
  reset(agentId: string): void {
    this.#state.delete(agentId);
  }

  clear(): void {
    this.#state.clear();
  }
}

/** What one raw runtime event says about recovery from runtime errors: output (thinking, text, a
 * tool call or its output), progress without output, or a finished phase (compaction, review). */
export type RuntimeErrorRecoverySignal = "output" | "progress" | "phase_finished";

/** What each recovery signal does to an Agent's two streaks: whether it ends a delivery backoff
 * (releasing what it held), and whether it resets the fingerprint fence's streak. A turn end is
 * not a signal here; the hold handles it on its own. */
export const RUNTIME_ERROR_RECOVERY_EFFECTS: Readonly<
  Record<RuntimeErrorRecoverySignal, Readonly<{ endsBackoff: boolean; resetsFence: boolean }>>
> = {
  output: { endsBackoff: true, resetsFence: true },
  progress: { endsBackoff: true, resetsFence: false },
  phase_finished: { endsBackoff: false, resetsFence: true },
};

/**
 * Maps a raw runtime event to its recovery signal, by the event kinds of the reference Computer
 * 1.0.50 (darwin-arm64, release cd67c4a2-20c5-41f4-a59c-f089887d01f7, sha256 b504580d…59b4fe,
 * observed 2026-10-20), connection.ts `runtimeErrorFingerprintFenceResetEvent` /
 * `clearRuntimeErrorDeliveryBackoffAfterProgress`. A `tool-end` is not among them, and a turn
 * end is reported to the hold on its own.
 */
export function runtimeErrorRecoverySignal(
  event: AgentRuntimeEvent,
): RuntimeErrorRecoverySignal | undefined {
  switch (event.type) {
    case "text-delta":
    case "thinking-delta":
    case "tool-start":
    case "tool-output":
      return "output";
    case "progress":
    case "subagent-progress":
      return "progress";
  }
  return PHASE_EDGES.get(event.type)?.[1] === "finish" ? "phase_finished" : undefined;
}
