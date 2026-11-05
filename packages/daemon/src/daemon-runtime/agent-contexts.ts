import { getLogger } from "@logtape/logtape";
import { parseRuntimeProvider, thrownMessage } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import type { AgentStateDb } from "#src/persistence/agent-state-db";
import { rebriefCompactedSessionMemory, type SessionMemoryHooks } from "./session-memory-hooks";

const logger = getLogger(["coforge", "daemon", "agent-contexts"]);

/** At most one re-brief this often per Agent: a compaction that ends, is re-briefed, and compacts
 * again must not turn into a loop of new turns. */
const REBRIEF_COOLDOWN_MS = 5 * 60_000;
/** Consecutive re-briefs without a launch in between; past this, the Agent is told once and the
 * re-briefs stop until its next launch. */
const REBRIEF_CONSECUTIVE_LIMIT = 3;

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
  /** The last re-brief each Agent got, and how many in a row without a launch: the guard that
   * keeps a compact → re-brief → compact cycle from feeding itself new turns. */
  readonly #rebriefs = new Map<string, { atMs: number; consecutive: number }>();

  constructor(
    private readonly stateDb: (agentId: string) => AgentStateDb,
    /** Read per event: the hooks' runtime collaborators do not exist when this field is built. */
    private readonly memory: () => SessionMemoryHooks,
  ) {}

  ledger(agentId: string): AgentContextLedger | undefined {
    if (!this.#reportsCompaction.get(agentId)) return undefined;
    // Not kept: the database handle is closed when the Agent stops or is forgotten.
    return new AgentContextLedger(this.stateDb(agentId).database);
  }

  /** The Agent's context starts over: a launch, whose `runtime` is then the one in use (its
   * session may be new), or a finished compaction. */
  newContext(agentId: string, runtime?: string): void {
    // No runtime means a finished compaction, and a cut context needs its MEMORY.md again — but a
    // session that compacts repeatedly (Pi re-compacts per turn while the context stays full)
    // must not get a new turn out of every finish: the cooldown and the consecutive cap stop the
    // cycle, and the suppression is logged so it is visible rather than silent.
    if (!runtime) this.#rebrief(agentId);
    if (runtime) {
      this.#reportsCompaction.set(agentId, reportsCompaction(runtime));
      this.#rebriefs.delete(agentId);
    }
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

  #rebrief(agentId: string): void {
    const now = Date.now();
    const previous = this.#rebriefs.get(agentId);
    const tooSoon = previous !== undefined && now - previous.atMs < REBRIEF_COOLDOWN_MS;
    const tooMany = previous !== undefined && previous.consecutive >= REBRIEF_CONSECUTIVE_LIMIT;
    if (tooSoon || tooMany) {
      logger.warn("Compaction re-brief suppressed", {
        event: "agent.runtime.compaction_rebrief_suppressed",
        agent_id: agentId,
        reason: tooMany ? "consecutive_limit" : "cooldown",
        consecutive: previous?.consecutive ?? 0,
        since_last_ms: previous === undefined ? undefined : now - previous.atMs,
      });
      return;
    }
    this.#rebriefs.set(agentId, {
      atMs: now,
      consecutive: (previous?.consecutive ?? 0) + 1,
    });
    void rebriefCompactedSessionMemory(this.memory(), agentId);
  }
}
