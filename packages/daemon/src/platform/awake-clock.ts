/**
 * Milliseconds on a clock that does not advance while the machine sleeps: a monotonic clock
 * (`performance.now()`: CLOCK_MONOTONIC on Linux, which "does not count time that the system is
 * suspended"; on macOS Bun's does not advance across sleep either, measured in the daemon's
 * logs). An age measured on it counts only time in which the machine, and so every process on it,
 * could run. Only differences of two readings mean anything; use `Date.now()` for a timestamp.
 */
export const awakeClockMs = (): number => performance.now();
