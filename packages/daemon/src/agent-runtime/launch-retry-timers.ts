import type { LaunchRetryScheduler } from "./launch-retry-scheduler";

type ArmedRetry = {
  handle: unknown;
  /** What the timer would run; a lifted quota wait runs it at once instead. */
  run: () => void;
  /** Set only for a retry that waits on a provider's quota reset, not for a short backoff. */
  quotaProvider?: string;
};

/**
 * The one pending automatic launch retry per Agent, and what each one waits for. A retry that
 * waits on a provider's quota reset (`quotaProvider`) can be ended early when that provider's
 * limit is lifted; a short backoff is never touched by that.
 */
export class LaunchRetryTimers {
  readonly #armed = new Map<string, ArmedRetry>();

  constructor(private readonly scheduler: LaunchRetryScheduler) {}

  has(agentId: string): boolean {
    return this.#armed.has(agentId);
  }

  /** Arms this Agent's retry; the caller has cancelled an earlier one. */
  arm(agentId: string, run: () => void, delayMs: number, quotaProvider?: string): void {
    this.#armed.set(agentId, {
      handle: this.scheduler.schedule(run, delayMs),
      run,
      ...(quotaProvider !== undefined ? { quotaProvider } : {}),
    });
  }

  /** The timer fired: the retry is no longer pending, and there is nothing to cancel. */
  fired(agentId: string): void {
    this.#armed.delete(agentId);
  }

  /** Cancels and forgets the Agent's retry; whether there was one. */
  cancel(agentId: string): boolean {
    const armed = this.#armed.get(agentId);
    if (armed === undefined) return false;
    this.#armed.delete(agentId);
    this.scheduler.cancel(armed.handle);
    return true;
  }

  cancelAll(): void {
    for (const armed of this.#armed.values()) this.scheduler.cancel(armed.handle);
    this.#armed.clear();
  }

  /**
   * `provider`'s limit was lifted: every retry waiting on that provider's quota runs now, as its
   * timer would have. The Start stays pending throughout, because the retry's own run counts
   * itself before this returns; cancelling through `cancel` would settle it in between.
   */
  endQuotaWaits(provider: string): number {
    const lifted = [...this.#armed].filter(([, armed]) => armed.quotaProvider === provider);
    for (const [agentId, armed] of lifted) {
      this.#armed.delete(agentId);
      this.scheduler.cancel(armed.handle);
      armed.run();
    }
    return lifted.length;
  }
}
