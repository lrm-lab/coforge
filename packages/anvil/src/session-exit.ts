import type { AgentSessionExit } from "@coforge/agent";

/**
 * One session's exit fan-out shared by the process-backed adapters: listeners registered
 * before the end fire once with how the process ended, and a listener attached after the
 * end replays that same detail. `finish` is idempotent like a process's single exit.
 */
export class SessionExit {
  readonly #listeners = new Set<(exit?: AgentSessionExit) => void>();
  #reported: { exit?: AgentSessionExit } | undefined;

  onExit(listener: (exit?: AgentSessionExit) => void): () => void {
    if (this.#reported) queueMicrotask(() => listener(this.#reported!.exit));
    else this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  finish(exit?: AgentSessionExit): void {
    if (this.#reported) return;
    this.#reported = { exit };
    for (const listener of this.#listeners) listener(exit);
    this.#listeners.clear();
  }
}
