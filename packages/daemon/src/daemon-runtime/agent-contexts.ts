import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import type { AgentStateDb } from "#src/persistence/agent-state-db";
import { reportsCompaction } from "./context-elision";

const logger = getLogger(["coforge", "daemon", "agent-contexts"]);

/**
 * Each Agent's context ledger, for the runtimes that report a finished compaction: only there
 * does the daemon know when the Agent's context was cut and what it must be told again. For any
 * other runtime `ledger` is undefined and nothing is ever left out of a read.
 */
export class AgentContexts {
  readonly #runtimes = new Map<string, string>();

  constructor(private readonly stateDb: (agentId: string) => AgentStateDb) {}

  ledger(agentId: string): AgentContextLedger | undefined {
    const runtime = this.#runtimes.get(agentId);
    if (!runtime || !reportsCompaction(runtime)) return undefined;
    // Not kept: the database handle is closed when the Agent stops or is forgotten.
    return new AgentContextLedger(this.stateDb(agentId).database);
  }

  /** The Agent's context starts over: a launch, whose `runtime` is then the one in use (its
   * session may be new), or a finished compaction. */
  newContext(agentId: string, runtime?: string): void {
    if (runtime) this.#runtimes.set(agentId, runtime);
    try {
      this.ledger(agentId)?.advance();
    } catch (error) {
      // The ledger is a convenience: a launch or a compaction finish must not fail over it. The
      // context stays as it was, so the Agent is shown less repeated text, never less new text.
      logger.warn("could not start a new Agent context", {
        event: "agent_context.advance_failed",
        agent_id: agentId,
        error: thrownMessage(error),
      });
    }
  }
}
