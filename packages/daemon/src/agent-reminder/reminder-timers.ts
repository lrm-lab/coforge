import type { ReminderClock } from "./reminder-clock";

const MAX_TIMER_MS = 24 * 60 * 60_000;

/** The pending timers of one kind, by key; none runs once the scheduler has stopped. */
export class ReminderTimers {
  readonly #timers = new Map<string, unknown>();

  constructor(
    private readonly clock: ReminderClock,
    private readonly isRunning: () => boolean,
  ) {}

  /**
   * Arms the timer for `key`, replacing any earlier one. It runs `onDue` once at `at` —
   * or after `MAX_TIMER_MS` if that is sooner, so a far deadline re-checks itself — unless a later
   * arm for the same key replaced it or the scheduler stopped in between.
   */
  arm(key: string, at: number, onDue: () => void): void {
    const timers = this.#timers;
    const timer = this.clock.schedule(
      () => {
        if (timers.get(key) !== timer) return;
        timers.delete(key);
        if (!this.isRunning()) return;
        onDue();
      },
      Math.min(Math.max(0, at - this.clock.now()), MAX_TIMER_MS),
    );
    this.cancel(key);
    timers.set(key, timer);
  }

  cancel(key: string): void {
    if (this.#timers.has(key)) this.clock.cancel(this.#timers.get(key));
    this.#timers.delete(key);
  }

  cancelWithPrefix(prefix: string): void {
    for (const [key, timer] of this.#timers)
      if (key.startsWith(prefix)) {
        this.clock.cancel(timer);
        this.#timers.delete(key);
      }
  }

  cancelAll(): void {
    for (const timer of this.#timers.values()) this.clock.cancel(timer);
    this.#timers.clear();
  }
}
