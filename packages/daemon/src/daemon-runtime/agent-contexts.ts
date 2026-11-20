import { getLogger } from "@logtape/logtape";
import { parseRuntimeProvider, thrownMessage } from "@lrm/coforge-sdk/internal";
import type { SessionResumeFacts } from "@lrm/coforge-anvil";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import type { NoticeMessage } from "./accepted-message-notices";
import { humanMemoryActivityTime } from "./memory-idle-review";
import { MemoryReviewLedger } from "#src/persistence/memory-review-ledger";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import {
  AgentSessionSummaryLedger,
  type SessionSummaryActivityInput,
  type SessionSummaryCompactionInput,
  type SessionSummaryContextInput,
} from "#src/persistence/agent-session-summary-ledger";
import {
  AgentStandingPromptLedger,
  type StandingPromptRecord,
  type StandingPromptRecordInput,
  type StandingPromptWriteResult,
} from "#src/persistence/agent-standing-prompt-ledger";
import { readMeta, writeMeta } from "#src/persistence/agent-state-db";
import type { AgentStateDb } from "#src/persistence/agent-state-db";

const logger = getLogger(["coforge", "daemon", "agent-contexts"]);

export const SESSION_NEEDS_RESET_THRESHOLD = 3;
const COMPACTION_FAILURES_KEY = "compactionFailures";

type CompactionFailureRecord = { sessionId?: string; model?: string; count: number };

export type CompactionFailureKind =
  | "compaction_failed"
  | "compaction_recovery_exhausted"
  | "compaction_input_too_large";

function reportsCompaction(provider: string): boolean {
  const known = parseRuntimeProvider(provider);
  if (!known) return false;
  try {
    return createCodeAgentProvider(known).reportsCompaction === true;
  } catch {
    return false;
  }
}

export class AgentContexts {
  readonly #reportsCompaction = new Map<string, boolean>();
  readonly #memoryGenerations = new Map<string, number>();

  constructor(private readonly stateDb: (agentId: string) => AgentStateDb) {}

  noteMemoryActivity(agentId: string, messages: readonly NoticeMessage[]): void {
    try {
      const times = messages.map(humanMemoryActivityTime).filter((time) => time !== undefined);
      if (times.length) this.memoryReviewLedger(agentId).noteHuman(Math.max(...times));
    } catch (error) {
      logger.warn("Personal memory human activity could not be recorded", {
        event: "memory_review:activity_failed",
        agent_id: agentId,
        error_code: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  memoryReviewLedger(agentId: string): MemoryReviewLedger {
    return new MemoryReviewLedger(this.stateDb(agentId).database);
  }

  noteSession(agentId: string, sessionId: string | undefined, model: string): void {
    try {
      const db = this.stateDb(agentId).database;
      const current = this.#failures(db);
      if (current && current.sessionId === sessionId && current.model === model) return;
      writeMeta(
        db,
        COMPACTION_FAILURES_KEY,
        JSON.stringify({ sessionId, model, count: 0 } satisfies CompactionFailureRecord),
      );
    } catch {}
  }

  needsSessionReset(agentId: string): boolean {
    try {
      return (
        (this.#failures(this.stateDb(agentId).database)?.count ?? 0) >=
        SESSION_NEEDS_RESET_THRESHOLD
      );
    } catch {
      return false;
    }
  }

  compactionFailed(
    agentId: string,
    kind: CompactionFailureKind = "compaction_failed",
  ): { consecutive: number; terminal: boolean } {
    let consecutive = 1;
    try {
      const db = this.stateDb(agentId).database;
      const current = this.#failures(db);
      consecutive = (current?.count ?? 0) + 1;
      writeMeta(
        db,
        COMPACTION_FAILURES_KEY,
        JSON.stringify({ ...current, count: consecutive } satisfies CompactionFailureRecord),
      );
    } catch {}
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

  compactionSucceeded(agentId: string): void {
    try {
      const db = this.stateDb(agentId).database;
      const current = this.#failures(db);
      if (current)
        writeMeta(
          db,
          COMPACTION_FAILURES_KEY,
          JSON.stringify({ ...current, count: 0 } satisfies CompactionFailureRecord),
        );
    } catch {}
  }

  #failures(db: AgentStateDb["database"]): CompactionFailureRecord | undefined {
    try {
      const parsed = JSON.parse(
        readMeta(db, COMPACTION_FAILURES_KEY) ?? "null",
      ) as Partial<CompactionFailureRecord> | null;
      return parsed && typeof parsed.count === "number"
        ? { sessionId: parsed.sessionId, model: parsed.model, count: parsed.count }
        : undefined;
    } catch {
      return undefined;
    }
  }

  ledger(agentId: string): AgentContextLedger | undefined {
    if (!this.#reportsCompaction.get(agentId)) return undefined;
    return new AgentContextLedger(this.stateDb(agentId).database);
  }

  standingPrompt(agentId: string): StandingPromptRecord | undefined {
    try {
      return new AgentStandingPromptLedger(this.stateDb(agentId).database).read();
    } catch {
      return undefined;
    }
  }

  recordStandingPrompt(
    agentId: string,
    input: StandingPromptRecordInput & { resumed?: boolean },
  ): StandingPromptWriteResult | undefined {
    try {
      const result = new AgentStandingPromptLedger(this.stateDb(agentId).database).record(input);
      if (result.changed && result.previous) {
        logger.info("Standing prompt changed for Agent session", {
          event: "agent.runtime.standing_prompt_changed",
          agent_id: agentId,
          provider: input.provider,
          ...(result.record.sessionId ? { session_id: result.record.sessionId } : {}),
          resumed: input.resumed === true,
          previous_hash: result.previous.hash,
          current_hash: result.record.hash,
          previous_bytes: result.previous.bytes,
          current_bytes: result.record.bytes,
        });
      }
      return result;
    } catch {
      return undefined;
    }
  }

  sessionResumeFacts(agentId: string, sessionId: string): SessionResumeFacts | undefined {
    try {
      return new AgentSessionSummaryLedger(this.stateDb(agentId).database).resumeFacts(sessionId);
    } catch {
      return undefined;
    }
  }

  recordSessionContextUsage(agentId: string, input: SessionSummaryContextInput): void {
    try {
      new AgentSessionSummaryLedger(this.stateDb(agentId).database).recordContextUsage(input);
    } catch {}
  }

  recordSessionCompaction(agentId: string, input: SessionSummaryCompactionInput): void {
    try {
      new AgentSessionSummaryLedger(this.stateDb(agentId).database).recordCompaction(input);
    } catch {}
  }

  recordSessionActivity(agentId: string, input: SessionSummaryActivityInput): void {
    try {
      new AgentSessionSummaryLedger(this.stateDb(agentId).database).recordActivity(input);
    } catch {}
  }

  /** Current context generation from `AgentContextLedger.generation()`, falling back to in-memory
   * tracking when the runtime does not persist a compaction ledger. */
  contextGeneration(agentId: string): number | undefined {
    try {
      const persisted = this.ledger(agentId)?.generation();
      if (persisted !== undefined) return persisted;
    } catch {
      // Fall back to the in-memory generation counter when stateDb is unavailable.
    }
    return this.#memoryGenerations.get(agentId);
  }

  /** Listeners told when an Agent's context starts over (a launch or a finished compaction), for
   * state that only the model's current context makes true. */
  readonly #newContextListeners = new Set<(agentId: string, runtime?: string) => void>();

  /** Registers a context-reset listener; returns its removal. */
  onNewContext(listener: (agentId: string, runtime?: string) => void): () => void {
    this.#newContextListeners.add(listener);
    return () => this.#newContextListeners.delete(listener);
  }

  /** The Agent's context starts over: a launch, whose `runtime` is then the one in use (its
   * session may be new), or a finished compaction. */
  newContext(agentId: string, runtime?: string): void {
    // A finished compaction starts the context over (the ledger below), and nothing is queued for
    // it: the two memory files arrive with the next fresh session instead (task #548). A launch
    // records the runtime whose adapter reports compactions; a compaction keeps it.
    if (runtime) this.#reportsCompaction.set(agentId, reportsCompaction(runtime));
    this.#memoryGenerations.set(agentId, (this.#memoryGenerations.get(agentId) ?? 0) + 1);
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
    for (const listener of this.#newContextListeners) {
      try {
        listener(agentId, runtime);
      } catch {
        // A listener must never fail a launch or a compaction bookkeeping step.
      }
    }
  }
}
