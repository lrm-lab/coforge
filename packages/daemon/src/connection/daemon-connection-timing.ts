/** The connection's clock and timers, injectable so a test can cross a liveness window at once. */
export interface DaemonConnectionTiming {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  scheduleRepeating?(callback: () => void, delayMs: number): unknown;
  cancelRepeating?(timer: unknown): void;
  /** The connection's own clock, so a test can cross the inbound-liveness window without
   * waiting for it. Production reads the wall clock. */
  now?(): number;
}

/** Real timers, unref'd: a connection must never be what keeps the daemon process alive. */
export const defaultDaemonConnectionTiming: DaemonConnectionTiming = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};
