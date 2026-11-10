import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What an Agent's life tells whoever follows it. */
export type AgentLifecycleListener = Readonly<{
  /** A person (or an operator) stopped the Agent, or deleted it. A launch torn down by the Daemon
   * is not that. */
  stopped?(agentId: string): void;
  /** The Agent's process ended, whatever ended it. */
  processClosed?(agentId: string): void;
}>;

/** The events of an Agent's life that more than one module follows, so the module that causes one
 * need not know who reacts. A listener that throws does not keep the others from the event. */
export class AgentLifecycle {
  readonly #listeners = new Set<AgentLifecycleListener>();

  subscribe(listener: AgentLifecycleListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  stopped(agentId: string): void {
    this.#notify("stopped", (listener) => listener.stopped?.(agentId));
  }

  processClosed(agentId: string): void {
    this.#notify("processClosed", (listener) => listener.processClosed?.(agentId));
  }

  #notify(event: string, tell: (listener: AgentLifecycleListener) => void): void {
    for (const listener of [...this.#listeners]) {
      try {
        tell(listener);
      } catch (error) {
        logger.error("An Agent lifecycle listener failed", {
          event: "agent.lifecycle.listener_failed",
          lifecycle_event: event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
