import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/** How often the daemon writes the notices the unread loop's retry schedule says are due.
 *
 * The schedule waits a minute, then five, then fifteen (`IMPORTANT_UNREAD_RETRY_DELAYS_MS`), so the
 * shortest delay is a minute and half of it keeps every retry within half of its own delay of the
 * moment it came due — a one-minute retry is never two minutes late, which a sweep as coarse as
 * that delay would make it. A finer tick buys nothing the schedule can tell apart: the loop decides
 * from the moment a retry became due, not from when a sweep happened to run. */
export const IMPORTANT_UNREAD_SWEEP_MS = 30_000;

export type ImportantUnreadSweepPorts = Readonly<{
  /** Asks the loop to write every notice whose retry is due and to report the batches that ran
   * out; returns how many Agents still had something to hear about, so a tick can say it ran. */
  flushDue(): number;
}>;

/**
 * Every `IMPORTANT_UNREAD_SWEEP_MS`, writes the notices the unread loop's retry schedule says are
 * due (task #14). The loop's write is how a reliable batch is told; nobody waits on it, so a notice
 * a session refused, or one written while the Agent was not looking, is repeated here on the state
 * machine's own schedule — not at the next message that happens to arrive, which for an Agent with
 * nothing else coming would be never. Reaching zero unread is the loop's business (`consumed`), and
 * a batch whose retries are spent is reported once by the loop, not by this sweep.
 */
export class ImportantUnreadSweep {
  readonly #ports: ImportantUnreadSweepPorts;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(ports: ImportantUnreadSweepPorts) {
    this.#ports = ports;
  }

  /** Idempotent; the timer never keeps the process alive. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), IMPORTANT_UNREAD_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One tick. The loop's flush is synchronous — it starts an attempt and returns — so two ticks
   * cannot overlap; a flush that throws is this tick's failure and the next one tries again. */
  sweep(): void {
    try {
      const pending = this.#ports.flushDue();
      // Debug, not info: a tick every half minute that wrote nothing is not news, and at info it
      // would be a thousand empty lines a day per Daemon. What did happen — a notice accepted, a
      // batch reported — is logged where it happens, by the loop itself.
      logger.debug("Agent unread notice sweep", {
        event: "agent.inbox_notice.sweep",
        agents_pending: pending,
      });
    } catch (error: unknown) {
      logger.warn("Agent unread notice sweep failed", {
        event: "agent.inbox_notice.sweep_failed",
        error: thrownMessage(error),
      });
    }
  }
}
