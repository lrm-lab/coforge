import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import type { AgentTurnInterruptResults } from "#src/server/agents/agent-turn-interrupt-results.server";

type Scope = { workspaceId: string; agentId: string; requestId: string };

/** Results live in this process only: the stand-in for Redis in unit tests. */
export class MemoryAgentTurnInterruptResults implements AgentTurnInterruptResults {
  readonly #results = new Map<string, AgentTurnInterruptResult>();

  async put(scope: Scope, result: AgentTurnInterruptResult) {
    const key = `${scope.workspaceId}:${scope.agentId}:${scope.requestId}`;
    if (!this.#results.has(key)) this.#results.set(key, result);
  }

  async read(scope: Scope) {
    return this.#results.get(`${scope.workspaceId}:${scope.agentId}:${scope.requestId}`);
  }
}
