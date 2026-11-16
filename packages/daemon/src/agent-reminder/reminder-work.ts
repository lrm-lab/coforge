import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "reminder"]);

/** Per-agent serial transitions and the external effects they start, which `awaitIdle` waits out. */
export class ReminderWork {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #effects = new Set<Promise<void>>();

  /** Waits until all currently-started transitions and external effects have settled. */
  async awaitIdle(): Promise<void> {
    for (;;) {
      const work = [...this.#queues.values(), ...this.#effects];
      if (work.length === 0) return;
      await Promise.all(work.map((item) => item.catch(() => {})));
      if ([...this.#queues.values(), ...this.#effects].every((item) => work.includes(item))) return;
    }
  }

  serial<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(agentId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.catch(() => {});
    this.#queues.set(agentId, settled);
    void settled.finally(() => {
      if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
    });
    return next;
  }

  track(effect: Promise<unknown>): void {
    const tracked = effect.then(
      () => {},
      (error) => {
        logger.error("Reminder async operation failed", { error });
      },
    );
    this.#effects.add(tracked);
    void tracked.finally(() => this.#effects.delete(tracked));
  }
}
