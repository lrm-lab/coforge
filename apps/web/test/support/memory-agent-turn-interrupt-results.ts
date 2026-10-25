import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import type { AgentTurnInterruptResults } from "#src/server/agents/agent-turn-interrupt-results.server";

type Scope = { workspaceId: string; agentId: string; requestId: string };
type Listener = () => void;

/** Results live in this process only: the stand-in for Redis in unit tests. */
export class MemoryAgentTurnInterruptResults implements AgentTurnInterruptResults {
  readonly #results = new Map<string, AgentTurnInterruptResult>();
  readonly #listeners = new Set<Listener>();

  async put(scope: Scope, result: AgentTurnInterruptResult) {
    const key = `${scope.workspaceId}:${scope.agentId}:${scope.requestId}`;
    if (!this.#results.has(key)) this.#results.set(key, result);
    for (const listener of [...this.#listeners]) listener();
  }

  wait(
    scope: Scope,
    timeoutMs: number,
    accept: (result: AgentTurnInterruptResult) => boolean,
  ): Promise<AgentTurnInterruptResult | "timeout"> {
    const key = `${scope.workspaceId}:${scope.agentId}:${scope.requestId}`;
    return new Promise((resolve) => {
      const finish = (value: AgentTurnInterruptResult | "timeout") => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(value);
      };
      const check = () => {
        const result = this.#results.get(key);
        if (result && accept(result)) finish(result);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      this.#listeners.add(check);
      check();
    });
  }
}
