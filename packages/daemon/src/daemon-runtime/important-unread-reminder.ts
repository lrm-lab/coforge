import type { ImportantUnreadNoticeStore } from "#src/persistence/important-unread-notice-store";
import {
  type ImportantUnreadDelivery,
  ImportantUnreadNotices,
  type ImportantUnreadNotice,
} from "./important-unread-notice";

/** The slice of the record this loop needs: keeping what a restart reads, and what it finds. */
export type ImportantUnreadRecord = Pick<ImportantUnreadNoticeStore, "save" | "clear" | "list">;

/** What writing a notice means to the rest of the daemon: put it into the Agent's process, and
 * tell a person when nothing more can be done. Both are the delivery path's own concerns. */
export type ImportantUnreadReminderPorts = Readonly<{
  /** Writes the notice into the Agent's process; false when it could not be accepted. */
  write(agentId: string, notice: ImportantUnreadNotice): boolean;
  /** The retries are used up and the Agent has not read: one error, once per batch. */
  report(agentId: string, notice: ImportantUnreadNotice): void;
}>;

/**
 * The loop around one Agent's unread state: fold deliveries in, write the notice when it is due,
 * retry on the state's own schedule, and stop when the batch is read (task #14). The state owns
 * the identity and the schedule; the store owns what a restart needs; this only sequences them,
 * which is what keeps every caller from deciding again when to write.
 */
export class ImportantUnreadReminder {
  /** Batches already reported as exhausted, so a sweep does not repeat the error. */
  readonly #reported = new Set<string>();

  constructor(
    private readonly notices: ImportantUnreadNotices,
    private readonly store: ImportantUnreadRecord,
    private readonly ports: ImportantUnreadReminderPorts,
    private readonly now: () => number = Date.now,
  ) {}

  /** Folds new deliveries in and writes what they made due. Best-effort traffic is ignored by
   * the state itself, so callers need not pre-filter. */
  observeDeliveries(deliveries: readonly ImportantUnreadDelivery[]): void {
    for (const delivery of deliveries) {
      const notice = this.notices.observe(delivery);
      if (!notice) continue;
      this.store.save(notice);
      this.#writeIfDue(notice.agentId);
    }
  }

  /** The Agent's read position moved: a batch it has passed is done and its record goes. */
  consumed(agentId: string, consumedThroughSequence: number): void {
    if (!this.notices.settle(agentId, consumedThroughSequence)) return;
    this.#reported.delete(agentId);
    this.store.clear(agentId);
  }

  /** What a starting Daemon takes over: nothing is written here, only recorded, so the first
   * sweep of the new process tells the Agent once (task #14: the watchdog does not wait). */
  restore(): void {
    for (const notice of this.store.list()) this.notices.restore(notice);
  }

  /** Writes every notice whose schedule says it is due, and reports the ones that ran out. */
  flushDue(): void {
    for (const agentId of this.notices.agents()) this.#writeIfDue(agentId);
  }

  #writeIfDue(agentId: string): void {
    const notice = this.notices.pending(agentId);
    if (!notice) return;
    if (this.notices.dueForWrite(agentId, this.now())) {
      if (!this.ports.write(agentId, notice)) return;
      const written = this.notices.recordWritten(agentId, this.now());
      if (written) this.store.save(written);
    }
    // A batch whose retries are used up is reported once, whatever the reason it stopped.
    if (!this.notices.retriesExhausted(agentId)) return;
    const key = `${agentId} ${notice.key}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.ports.report(agentId, notice);
  }
}
