import { getLogger } from "@logtape/logtape";
import { parseRuntimeProvider, thrownMessage } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import type { AgentStateDb } from "#src/persistence/agent-state-db";

const logger = getLogger(["coforge", "daemon", "agent-contexts"]);

/** The adapter's own declaration; a provider this build does not know is never elided. */
function reportsCompaction(provider: string): boolean {
  const known = parseRuntimeProvider(provider);
  if (!known) return false;
  try {
    return createCodeAgentProvider(known).reportsCompaction === true;
  } catch {
    return false;
  }
}

/**
 * Each Agent's context ledger, for the runtimes whose adapter declares a finished compaction
 * (`CodeAgentProvider.reportsCompaction`): only there does the daemon know when the Agent's
 * context was cut and what it must be told again. For any other runtime `ledger` is undefined and
 * nothing is ever left out of a read.
 */
export class AgentContexts {
  /** Whether this Agent's adapter reports a finished compaction; absent before its first launch. */
  readonly #reportsCompaction = new Map<string, boolean>();

  constructor(private readonly stateDb: (agentId: string) => AgentStateDb) {}

  ledger(agentId: string): AgentContextLedger | undefined {
    if (!this.#reportsCompaction.get(agentId)) return undefined;
    // Not kept: the database handle is closed when the Agent stops or is forgotten.
    return new AgentContextLedger(this.stateDb(agentId).database);
  }

  /** The Agent's context starts over: a launch, whose `runtime` is then the one in use (its
   * session may be new), or a finished compaction. */
  newContext(agentId: string, runtime?: string): void {
    if (runtime) this.#reportsCompaction.set(agentId, reportsCompaction(runtime));
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
