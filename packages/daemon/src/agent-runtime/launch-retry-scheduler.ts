/** Injectable timer seam for the automatic launch retry: production uses plain `setTimeout`, and
 * tests drive the delays deterministically instead of sleeping through them. */
export type LaunchRetryScheduler = {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

/** The longest delay one `setTimeout` honours. A longer wait is sliced so it does not fire at
 * once, which a signed 32-bit timer does past this bound. */
export const LAUNCH_RETRY_TIMER_LIMIT_MS = 2 ** 31 - 1;

/** Real timers. A wait past `LAUNCH_RETRY_TIMER_LIMIT_MS` re-arms until the remainder fits, so a
 * quota reset days away is not treated as "retry immediately". */
export const systemLaunchRetryScheduler: LaunchRetryScheduler = {
  schedule(callback, delayMs) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const arm = (remainingMs: number) => {
      const slice = Math.min(Math.max(0, remainingMs), LAUNCH_RETRY_TIMER_LIMIT_MS);
      timer = setTimeout(() => {
        if (cancelled) return;
        if (remainingMs > LAUNCH_RETRY_TIMER_LIMIT_MS)
          arm(remainingMs - LAUNCH_RETRY_TIMER_LIMIT_MS);
        else callback();
      }, slice);
    };
    arm(delayMs);
    return {
      cancel() {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  },
  cancel(handle) {
    if (
      handle &&
      typeof handle === "object" &&
      "cancel" in handle &&
      typeof handle.cancel === "function"
    )
      handle.cancel();
  },
};
