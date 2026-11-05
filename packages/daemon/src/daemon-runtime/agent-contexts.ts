import { getLogger } from "@logtape/logtape";
import { parseRuntimeProvider, thrownMessage } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import { readMeta, writeMeta } from "#src/persistence/agent-state-db";
import type { AgentStateDb } from "#src/persistence/agent-state-db";

const logger = getLogger(["coforge", "daemon", "agent-contexts"]);

/** Consecutive compaction failures that make the session spent: Raft's
 * `SESSION_NEEDS_RESET_THRESHOLD` (`sessionCompactionFailureLedger.ts`). */
export const SESSION_NEEDS_RESET_THRESHOLD = 3;
const COMPACTION_FAILURES_KEY = "compactionFailureCount";

export type CompactionFailureKind =
  | "compaction_failed"
  | "compaction_recovery_exhausted"
  | "compaction_input_too_large";

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

  /** One compaction failure: the per-Agent count is persisted with its state, so a restart does
   * not hide a session that keeps failing. An input too large is spent at once. */
  compactionFailed(
    agentId: string,
    kind: CompactionFailureKind = "compaction_failed",
  ): { consecutive: number; terminal: boolean } {
    let consecutive = 1;
    try {
      const db = this.stateDb(agentId).database;
      consecutive = Number(readMeta(db, COMPACTION_FAILURES_KEY) ?? 0) + 1;
      writeMeta(db, COMPACTION_FAILURES_KEY, String(consecutive));
    } catch {
      // The count is a safety net, never a reason to fail the turn.
    }
    const terminal =
      kind === "compaction_input_too_large" || consecutive >= SESSION_NEEDS_RESET_THRESHOLD;
    logger.warn("Context compaction failed", {
      event: "agent.runtime.compaction_failed",
      agent_id: agentId,
      failure_kind: kind,
      consecutive,
      terminal,
    });
    if (terminal)
      logger.error("Context compaction exhausted the session", {
        event: "agent.runtime.compaction_recovery_exhausted",
        agent_id: agentId,
        failure_kind: kind,
        consecutive,
      });
    return { consecutive, terminal };
  }

  /** A finished compaction proves the session still compacts: the count starts over. */
  compactionSucceeded(agentId: string): void {
    try {
      writeMeta(this.stateDb(agentId).database, COMPACTION_FAILURES_KEY, "0");
    } catch {
      // Nothing to reset when the state cannot be read.
    }
  }

  ledger(agentId: string): AgentContextLedger | undefined {
    if (!this.#reportsCompaction.get(agentId)) return undefined;
    // Not kept: the database handle is closed when the Agent stops or is forgotten.
    return new AgentContextLedger(this.stateDb(agentId).database);
  }

  /** The Agent's context starts over: a launch, whose `runtime` is then the one in use (its
   * session may be new), or a finished compaction. */
  newContext(agentId: string, runtime?: string): void {
    // A finished compaction starts the context over (the ledger below), and nothing is queued for
    // it: the two memory files arrive with the next fresh session instead (task #548). A launch
    // records the runtime whose adapter reports compactions; a compaction keeps it.
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
