export interface ReminderClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

/** Wall-clock time and unref'd timers, so a pending timer never keeps the daemon alive. */
export const defaultClock: ReminderClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};
