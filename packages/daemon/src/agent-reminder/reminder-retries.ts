import type { ReminderClock } from "./reminder-clock";

export const REMINDER_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

export type ReminderAttempt = () => Promise<boolean>;

export class ReminderRetries {
  readonly #timers = new Map<string, unknown>();
  #stopped = false;

  constructor(
    private readonly clock: ReminderClock,
    private readonly delaysMs: readonly number[] = REMINDER_RETRY_DELAYS_MS,
  ) {}

  later(key: string, attempt: ReminderAttempt, onGiveUp: () => void, step = 0): void {
    if (this.#stopped) return;
    this.cancel(key);
    const delayMs = this.delaysMs[step];
    if (delayMs === undefined) {
      onGiveUp();
      return;
    }
    const timer = this.clock.schedule(() => {
      if (this.#timers.get(key) !== timer) return;
      this.#timers.delete(key);
      void settle(attempt).then((done) => {
        if (!done) this.later(key, attempt, onGiveUp, step + 1);
      });
    }, delayMs);
    this.#timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.#timers.get(key);
    if (timer === undefined) return;
    this.#timers.delete(key);
    this.clock.cancel(timer);
  }

  stop(): void {
    this.#stopped = true;
    for (const key of this.#timers.keys()) this.cancel(key);
  }
}

export const settle = (attempt: ReminderAttempt): Promise<boolean> => attempt().catch(() => false);
