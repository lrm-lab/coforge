/**
 * Per-Agent launch-failure backoff: each failed launch counts, and the next attempt waits an
 * exponentially growing, capped cooldown instead of burning immediately, so repeated wakes
 * cannot burn one full spawn attempt per delivery.
 *
 * Pure bookkeeping on purpose: no timers, no I/O, no knowledge of `AgentControl`. The caller
 * decides what to do with the computed cooldown (AgentControl schedules the retry, tests assert
 * the numbers directly). State lives in memory for this daemon instance only: a launch failure
 * is a fact about the local process/host, not something that should outlive the daemon that
 * observed it.
 */

/** First cooldown: one second. */
export const LAUNCH_FAILURE_BACKOFF_BASE_MS = 1_000;
/** Cooldown ceiling: thirty seconds. */
export const LAUNCH_FAILURE_BACKOFF_CAP_MS = 30_000;
/**
 * One initial attempt plus at most (this - 1) automatic retries. With the base/cap above the
 * cooldowns are 1s, 2s, 4s, 8s, 16s, 30s — the cap is actually reached — for a ~61s total retry
 * window before the daemon reports `launch_failed` exactly as it did before this change. Bounded
 * (a capped cooldown alone would retry forever) so a permanently broken launch configuration
 * cannot leave the server's Start operation in "starting" forever.
 */
export const LAUNCH_FAILURE_MAX_ATTEMPTS = 7;

export type LaunchFailureBackoffState = Readonly<{
  /** Consecutive failed launches for this Agent, including the one just recorded. */
  attempts: number;
  /** How long the caller must wait before the next attempt, in milliseconds. */
  cooldownMs: number;
  /** Absolute epoch-milliseconds time at which the next attempt becomes due. */
  untilMs: number;
}>;

/** `base * 2^(attempts - 1)`, capped: backs off from the first failure, with the exponent bound
 * folded into the millisecond cap. */
export function launchFailureCooldownMs(
  attempts: number,
  baseMs: number = LAUNCH_FAILURE_BACKOFF_BASE_MS,
  capMs: number = LAUNCH_FAILURE_BACKOFF_CAP_MS,
): number {
  if (attempts < 1) return baseMs;
  // Bound the exponent before it overflows a float's exact-integer range; the minute cap below
  // is reached long before this matters.
  const exponent = Math.min(attempts - 1, 30);
  return Math.min(baseMs * 2 ** exponent, capMs);
}

export class LaunchFailureBackoff {
  readonly #failures = new Map<
    string,
    {
      attempts: number;
      untilMs: number;
      recoveryWait: boolean;
      /** Failures that did not wait on a named recovery time. */
      streak: number;
      /** A failure no retry can fix was recorded. */
      terminal: boolean;
      /** When this streak's first failure was recorded: the clock a total deadline runs on. */
      startedAtMs: number;
    }
  >();

  readonly #listeners: Array<(agentId: string) => void> = [];

  constructor(
    private readonly baseMs: number = LAUNCH_FAILURE_BACKOFF_BASE_MS,
    private readonly capMs: number = LAUNCH_FAILURE_BACKOFF_CAP_MS,
  ) {}

  /**
   * Records one failed attempt for `agentId` and returns the cooldown the next attempt owes.
   * `cooldownMs`, when positive, replaces the exponential cooldown: a quota failure that names
   * a recovery time waits until then. The attempt still counts. Omitting it keeps the short
   * backoff, which stops growing at the cap. `terminal` says no retry can fix this failure.
   */
  recordFailure(
    agentId: string,
    now: number = Date.now(),
    cooldownMs?: number,
    terminal = false,
  ): LaunchFailureBackoffState {
    const previous = this.#failures.get(agentId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const recoveryWait = cooldownMs !== undefined && Number.isFinite(cooldownMs) && cooldownMs > 0;
    const cooldown = recoveryWait
      ? cooldownMs
      : launchFailureCooldownMs(attempts, this.baseMs, this.capMs);
    const untilMs = now + cooldown;
    this.#failures.set(agentId, {
      attempts,
      untilMs,
      recoveryWait,
      streak: (previous?.streak ?? 0) + (recoveryWait ? 0 : 1),
      terminal: terminal || previous?.terminal === true,
      // A total deadline measures the attempts themselves, so a wait on something outside the
      // runtime does not run it down: a failure that names a recovery time starts the clock when
      // that wait ends. A streak of ordinary failures keeps the first one's start, so repeated
      // attempts cannot push the deadline out (task #32).
      startedAtMs: recoveryWait ? untilMs : (previous?.startedAtMs ?? now),
    });
    for (const listener of this.#listeners) listener(agentId);
    return { attempts, cooldownMs: cooldown, untilMs };
  }

  /** Calls `listener` with the Agent each time a failure has been recorded. */
  onFailure(listener: (agentId: string) => void): void {
    this.#listeners.push(listener);
  }

  /**
   * Ends the cooldowns that were a named recovery time (a provider's quota reset) for the Agents
   * `belongs` accepts, forgetting their streaks; a short exponential backoff is not a wait on
   * anything that can be lifted, so it stays. Returns how many ended.
   */
  endRecoveryWaits(belongs: (agentId: string) => boolean): number {
    let ended = 0;
    for (const [agentId, failure] of this.#failures)
      if (failure.recoveryWait && belongs(agentId) && this.#failures.delete(agentId)) ended += 1;
    return ended;
  }

  /** Clears the streak after a successful launch (or an explicit Stop). Returns how many
   * consecutive failures were cleared, so the caller can narrate a recovery only when there was
   * one. */
  reset(agentId: string): number {
    const attempts = this.attempts(agentId);
    this.#failures.delete(agentId);
    return attempts;
  }

  /** Whether the Agent's failures leave nothing to retry: one no retry can fix, `cap`
   * consecutive ones that were not waits on a named recovery time, or a streak that has been
   * running longer than `deadlineMs` allows. */
  exhausted(agentId: string, cap: number, now: number = Date.now(), deadlineMs?: number): boolean {
    const failure = this.#failures.get(agentId);
    if (!failure) return false;
    if (failure.terminal || failure.streak >= cap) return true;
    return deadlineMs !== undefined && now - failure.startedAtMs >= deadlineMs;
  }

  /** When this streak began, for the log line that narrates giving up. */
  streakStart(agentId: string): number | undefined {
    return this.#failures.get(agentId)?.startedAtMs;
  }

  attempts(agentId: string): number {
    return this.#failures.get(agentId)?.attempts ?? 0;
  }

  blockedUntil(agentId: string): number | undefined {
    return this.#failures.get(agentId)?.untilMs;
  }

  /** True while this Agent owes a cooldown before its next attempt. */
  isBlocked(agentId: string, now: number = Date.now()): boolean {
    const untilMs = this.blockedUntil(agentId);
    return untilMs !== undefined && untilMs > now;
  }

  clear(): void {
    this.#failures.clear();
  }
}
