import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import type { AgentStateDb } from "#src/persistence/agent-state-db";
import { reportsCompaction } from "./context-elision";

/**
 * Each Agent's context ledger, for the runtimes that report a finished compaction: only there
 * does the daemon know when the Agent's context was cut and what it must be told again. For any
 * other runtime `ledger` is undefined and nothing is ever left out of a read.
 */
export class AgentContexts {
  readonly #ledgers = new Map<string, AgentContextLedger>();
  readonly #runtimes = new Map<string, string>();

  constructor(private readonly stateDb: (agentId: string) => AgentStateDb) {}

  ledger(agentId: string): AgentContextLedger | undefined {
    const runtime = this.#runtimes.get(agentId);
    if (!runtime || !reportsCompaction(runtime)) return undefined;
    let ledger = this.#ledgers.get(agentId);
    if (!ledger) {
      ledger = new AgentContextLedger(this.stateDb(agentId).database);
      this.#ledgers.set(agentId, ledger);
    }
    return ledger;
  }

  /** The Agent's context starts over: a launch, whose `runtime` is then the one in use (its
   * session may be new), or a finished compaction. */
  newContext(agentId: string, runtime?: string): void {
    if (runtime) this.#runtimes.set(agentId, runtime);
    this.ledger(agentId)?.advance();
  }
}
