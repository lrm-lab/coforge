import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

/** The first wait after a failed catalog probe; each further failure doubles it. */
export const CATALOG_RETRY_BASE_MS = 5 * 60_000;
/** The longest wait: a runtime that keeps failing is still retried once an hour. */
export const CATALOG_RETRY_MAX_MS = 60 * 60_000;

type RetryState = { attempts: number; nextAttemptAt: number };

/**
 * When each provider whose catalog probe failed may be probed again. A first scan can fail for a
 * reason that passes (a network fetch that timed out while every runtime was probed at once), so
 * the failure is a delay, never a verdict: the wait doubles from five minutes to an hour, and a
 * provider that reports a catalog again leaves the schedule entirely.
 */
export class CatalogRetrySchedule {
  readonly #states = new Map<RuntimeProvider, RetryState>();

  /** One discovery pass: its failures wait longer, its successes are forgotten. */
  settle(
    failures: readonly { provider: RuntimeProvider }[],
    succeeded: readonly { provider: RuntimeProvider }[],
    now: number,
  ): void {
    for (const { provider } of succeeded) this.#states.delete(provider);
    for (const { provider } of failures) {
      const attempts = (this.#states.get(provider)?.attempts ?? 0) + 1;
      this.#states.set(provider, {
        attempts,
        nextAttemptAt:
          now + Math.min(CATALOG_RETRY_MAX_MS, CATALOG_RETRY_BASE_MS * 2 ** (attempts - 1)),
      });
    }
  }

  /** The providers whose next attempt is due, oldest attempt first. */
  due(now: number): RuntimeProvider[] {
    return [...this.#states]
      .filter(([, state]) => state.nextAttemptAt <= now)
      .map(([provider]) => provider);
  }
}
