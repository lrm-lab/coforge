import type { AgentRuntimeEvent } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { PhaseTracker } from "#src/agent-runtime/phase-tracker";
import {
  inferredCompactionFinish,
  RUNTIME_PHASES,
  type CompactionInference,
  type CompactionInterruption,
  type PhaseActivity,
  type RuntimePhase,
} from "#src/agent-runtime/runtime-phases";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentContexts } from "./agent-contexts";
import type { ActivityDraft, PublishedActivityLaunch } from "./agent-activity-publisher";
import { compactionFailureKind } from "./compaction-failure-kind";

const logger = getLogger(["coforge", "daemon", "daemon-runtime"]);

/** How much of a runtime's own compaction failure text one log line keeps. The line is a
 * diagnostic, not the error surface: the Activity and the launch failure path carry the rest. */
export const COMPACTION_LOG_ERROR_CHARS = 400;

/** The token numbers a finished compaction reports for itself, when its runtime has them. */
export type CompactionTokens = Readonly<{
  tokensBefore?: number;
  tokensAfter?: number;
  windowTokens?: number;
}>;

/** A context reading, and when the runtime sampled it. */
export type ContextReading = Readonly<{
  usedTokens: number;
  windowTokens: number;
  observedAtMs: number;
}>;

/** A compaction that ended before its result was known, waiting for it. The runtimes that report
 * no numbers of their own (Claude Code, Codex) produce their context reading at the end of the
 * turn the compaction ran in — after the boundary that ends the compaction — so the line waits
 * for that reading instead of saying the compaction freed nothing (task #16). */
type EndedCompaction = Readonly<{
  outcome: "finished" | "inferred" | "interrupted";
  tokensBefore?: number;
  /** When the compaction ended. The daily report attributes the line by this, not by when the line
   * was written, since a held line is written at the end of the turn. */
  endedAtMs: number;
  /** The newest reading sample this compaction knows of: the one it opened on, or, once the line
   * is held, the one that was on record when it was held — so the same sample cannot end the wait. */
  seenAtMs?: number;
  readingsExist: boolean;
  reported?: CompactionTokens;
  interruption?: CompactionInterruption;
}>;

/** The reading that is this compaction's result, or `undefined` while there is none: a later
 * sample than the reading this compaction knows of, and never a zero — Codex writes one around a
 * compaction, and a compacted context still holds its summary, so zero is a sentinel rather than a
 * measurement.
 *
 * `mustBeSmaller` applies only while the compaction's end is being observed: a reading on record
 * then may still be the one taken before it started, which repeats the starting count and would
 * say the compaction freed nothing. A reading that arrives after the end was observed is a fresh
 * sample taken after the compaction, so it need not be smaller — the turn it ends may well have
 * grown past the count the compaction opened on, which is all Claude Code ever has to compare to. */
function compactionResult(
  ended: EndedCompaction,
  reading: ContextReading | undefined,
  { mustBeSmaller }: { mustBeSmaller: boolean },
): ContextReading | undefined {
  if (!reading || reading.usedTokens <= 0) return undefined;
  if (ended.seenAtMs !== undefined && reading.observedAtMs <= ended.seenAtMs) return undefined;
  if (mustBeSmaller && ended.tokensBefore !== undefined && reading.usedTokens >= ended.tokensBefore)
    return undefined;
  return reading;
}

/** The runtime supplies only where Activity goes: the current launch, its draft builder, and the
 * publisher. Providers report raw phase signals; this module decides what each becomes on the
 * wire — see `agent-runtime/phase-tracker.ts` for the watchdog semantics. */
export type PhaseBookkeepingPorts = Readonly<{
  launchFor(agentId: string): ActivityLaunch | undefined;
  publish(agentId: string, launch: PublishedActivityLaunch, activity: ActivityDraft): void;
  activityDraft(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    detail: string,
  ): ActivityDraft;
  /** A finished compaction starts the Agent's context over; a failed one counts toward the
   * session being spent. */
  contexts: Pick<AgentContexts, "newContext" | "compactionFailed" | "compactionSucceeded">;
  /** The Agent's last context-usage reading and when it was taken: a compaction's token numbers,
   * when one was observed — and only the one observed after it started counts as its result. */
  contextUsage?(agentId: string): ContextReading | undefined;
}>;

/**
 * Whether each phase is open per Agent, and its stale watchdog. A compaction also ends,
 * inferred, on resumed output, a new tool call, or the turn's end. A review does not end on
 * output or a tool call, since it is made of both; the turn's end closes it without a row.
 */
export class PhaseBookkeeping {
  readonly #phases: Readonly<Record<RuntimePhase, PhaseTracker>>;
  /** Where each open compaction started: the reading it saw then, so a reading from before it
   * cannot be read back as its result. */
  readonly #compactionBefore = new Map<string, { usedTokens?: number; seenAtMs?: number }>();
  /** Compactions whose line waits for the turn's reading — see `EndedCompaction`. */
  readonly #endedCompactions = new Map<string, EndedCompaction>();
  /** Failures seen while this compaction stayed open: the second one means its recovery did not
   * help, and Raft counts it as exhausted. */
  readonly #compactionAttempts = new Map<string, number>();
  /** Agents already told that their session needs a reset: the notice is worth one row, and the
   * counter that produced it does not fall by saying the same thing again. */
  readonly #resetNoticeSent = new Set<string>();

  constructor(private readonly ports: PhaseBookkeepingPorts) {
    this.#phases = {
      compaction: this.#track("compaction"),
      review: this.#track("review"),
    };
  }

  /** One line per compaction that ends, with the numbers the runtime itself reported for the
   * compaction first, then our own context readings. A missing number stays missing — this never
   * invents one to look complete. */
  #endCompaction(
    agentId: string,
    outcome: EndedCompaction["outcome"],
    reported?: CompactionTokens,
    interruption?: CompactionInterruption,
  ): void {
    const started = this.#compactionBefore.get(agentId);
    this.#compactionBefore.delete(agentId);
    this.#compactionAttempts.delete(agentId);
    const reading = this.ports.contextUsage?.(agentId);
    const ended: EndedCompaction = {
      outcome,
      tokensBefore: reported?.tokensBefore ?? started?.usedTokens,
      endedAtMs: Date.now(),
      seenAtMs: started?.seenAtMs,
      // Whether this runtime has ever produced a reading for the Agent tells a missed reading
      // from a runtime that has none to give: only some runtimes emit them at all.
      readingsExist: started?.seenAtMs !== undefined || reading !== undefined,
      reported,
      interruption,
    };
    const result = compactionResult(ended, reading, { mustBeSmaller: true });
    // An interruption says why the compaction ended rather than how much it freed, so it does not
    // wait for a number; a runtime that reports its own numbers needs none either.
    if (outcome === "interrupted" || reported?.tokensAfter !== undefined || result) {
      this.#writeCompactionLine(agentId, ended, result);
      return;
    }
    // Claude Code reports its reading at the end of the turn the compaction ran in: hold the line
    // until that reading lands (`contextUsageObserved`) or the turn ends without one (`turnEnded`).
    // The sample already on record cannot end the wait, so the hold remembers it as the newest.
    this.#endedCompactions.set(agentId, {
      ...ended,
      seenAtMs: reading?.observedAtMs ?? ended.seenAtMs,
    });
  }

  /** A context reading arrived for an Agent: resolve a compaction that ended before it. */
  contextUsageObserved(agentId: string): void {
    const ended = this.#endedCompactions.get(agentId);
    if (!ended) return;
    const result = compactionResult(ended, this.ports.contextUsage?.(agentId), {
      mustBeSmaller: false,
    });
    if (!result) return;
    this.#endedCompactions.delete(agentId);
    this.#writeCompactionLine(agentId, ended, result, true);
  }

  /** The Agent's turn is over: a held compaction line is written now, saying what it lacks. */
  turnEnded(agentId: string): void {
    const ended = this.#endedCompactions.get(agentId);
    if (!ended) return;
    this.#endedCompactions.delete(agentId);
    this.#writeCompactionLine(agentId, ended, undefined, true);
  }

  #writeCompactionLine(
    agentId: string,
    ended: EndedCompaction,
    result: ContextReading | undefined,
    held = false,
  ): void {
    const { reported, interruption } = ended;
    const tokensAfter = reported?.tokensAfter ?? result?.usedTokens;
    const lastReading = this.ports.contextUsage?.(agentId);
    logger.info("Context compaction ended", {
      event: "agent.runtime.compaction_tokens",
      agent_id: agentId,
      outcome: ended.outcome,
      // When the compaction ended, so the daily report buckets this line by the compaction rather
      // than by when it was written, and `delayed_ms` says how long it waited for its reading.
      compaction_ended_at: new Date(ended.endedAtMs).toISOString(),
      ...(held ? { delayed_ms: Math.max(0, Date.now() - ended.endedAtMs) } : {}),
      tokens_before: ended.tokensBefore,
      tokens_after: tokensAfter,
      window_tokens: reported?.windowTokens ?? result?.windowTokens ?? lastReading?.windowTokens,
      // Where the after number came from: the runtime's own compaction result, or one of our
      // context readings. The daily report splits its trend on this instead of guessing versions,
      // because a reading-derived number under the old code could only repeat the starting count.
      ...(tokensAfter === undefined
        ? {
            tokens_after_unavailable:
              ended.readingsExist || lastReading !== undefined
                ? "no_reading_after_compaction"
                : "runtime_reports_no_readings",
          }
        : { tokens_source: reported?.tokensAfter !== undefined ? "runtime" : "reading" }),
      // An interruption nobody explained stays visibly unexplained rather than reading as a plain
      // ending, and the runtime's own reason and failure text are bounded like every log field.
      ...(interruption
        ? {
            reason: interruption.reason ?? null,
            interrupted_by: interruption.interruptedBy ?? null,
            ...(interruption.errorMessage
              ? { error_message: interruption.errorMessage.slice(0, COMPACTION_LOG_ERROR_CHARS) }
              : {}),
          }
        : {}),
    });
  }

  #track(phase: RuntimePhase): PhaseTracker {
    const {
      staleMs,
      stale: [detailKind, detail],
    } = RUNTIME_PHASES[phase];
    return new PhaseTracker((agentId) => {
      const launch = this.ports.launchFor(agentId);
      if (launch)
        this.ports.publish(agentId, launch, this.ports.activityDraft(agentId, detailKind, detail));
    }, staleMs);
  }

  /** Opens a phase once, reporting its start; a repeated start while it is open reports nothing. */
  start(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    if (this.#phases[phase].start(agentId) !== "started") return;
    this.#publish(agentId, launch, RUNTIME_PHASES[phase].started, conversation);
    if (phase === "compaction") {
      // A compaction that ended and never got its reading is written before this one opens, so
      // the older line cannot be lost behind the newer start.
      this.turnEnded(agentId);
      const seen = this.ports.contextUsage?.(agentId);
      this.#compactionBefore.set(agentId, {
        usedTokens: seen?.usedTokens,
        seenAtMs: seen?.observedAtMs,
      });
    }
  }

  /** Ends an open phase once on its own finish signal. */
  finish(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
    reported?: CompactionTokens,
  ): void {
    if (this.#phases[phase].finish(agentId) !== "finished") return;
    this.#publish(agentId, launch, RUNTIME_PHASES[phase].finished, conversation);
    if (phase === "compaction") {
      this.ports.contexts.newContext(agentId);
      this.ports.contexts.compactionSucceeded(agentId);
      // Recovered: a later exhaustion is news again.
      this.#resetNoticeSent.delete(agentId);
      this.#endCompaction(agentId, "finished", reported);
    }
  }

  /** Ends an open compaction once, before the Activity that established its completion. */
  inferCompactionFinished(
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
    { inferredFrom }: { inferredFrom: CompactionInference },
  ): void {
    if (this.#phases.compaction.finish(agentId) !== "finished") return;
    this.#publish(agentId, launch, inferredCompactionFinish(inferredFrom), conversation);
    this.ports.contexts.newContext(agentId);
    this.#endCompaction(agentId, "inferred");
  }

  /** Ends an open phase once as interrupted, for a phase that reports interruptions.
   *
   * A compaction that keeps failing leaves the session unable to make room; past the threshold it
   * is spent, and only a fresh session helps. A cancelled compaction is the person (or the daemon)
   * stopping it, not the context failing to compact — counting it would condemn a session after a
   * few stops — so only `interruptedBy: "failed"` counts, whatever the runtime's own wording. */
  interrupt(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
    interruption?: CompactionInterruption,
  ): void {
    const interrupted = RUNTIME_PHASES[phase].interrupted;
    if (!interrupted) return;
    const failed = phase === "compaction" && interruption?.interruptedBy === "failed";
    // Before the phase closes: the count only applies to an attempt that is still open.
    if (failed)
      this.compactionError(agentId, launch, interruption?.errorMessage ?? "compaction failed");
    if (this.#phases[phase].interrupt(agentId) !== "interrupted") return;
    this.#publish(agentId, launch, interrupted, conversation);
    if (phase !== "compaction") return;
    this.#endCompaction(agentId, "interrupted", undefined, interruption);
  }

  /** A runtime error that arrives while a compaction is open is that compaction failing. Counted
   * once per attempt: a second failure with the compaction still open is a recovery that did not
   * help. Past the threshold the session is spent, and only a reset helps — said once per launch,
   * not once more for every failure that follows the threshold. */
  compactionError(agentId: string, launch: PublishedActivityLaunch, message: string): void {
    if (!this.#phases.compaction.isActive(agentId)) return;
    const attempts = (this.#compactionAttempts.get(agentId) ?? 0) + 1;
    this.#compactionAttempts.set(agentId, attempts);
    const { terminal } = this.ports.contexts.compactionFailed(
      agentId,
      compactionFailureKind(message, attempts),
    );
    if (!terminal || this.#resetNoticeSent.has(agentId)) return;
    this.#resetNoticeSent.add(agentId);
    this.ports.publish(
      agentId,
      launch,
      this.ports.activityDraft(
        agentId,
        "runtime_error",
        "Context compaction failed repeatedly; reset the session from the Agent page (Reset session & restart).",
      ),
    );
  }

  /** Closes an open phase with no Activity row — the review's quiet ending at a turn's end. */
  closeSilently(phase: RuntimePhase, agentId: string): void {
    this.#phases[phase].finish(agentId);
  }

  #publish(
    agentId: string,
    launch: ActivityLaunch,
    [detailKind, detail]: PhaseActivity,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    this.ports.publish(agentId, launch, {
      ...this.ports.activityDraft(agentId, detailKind, detail),
      ...(conversation
        ? { conversationId: conversation.conversationId, conversationTarget: conversation.target }
        : {}),
    });
  }

  /** Forgets one Agent's open phases and stops their watchdogs. */
  dispose(agentId: string): void {
    // A held line is written before the Agent is forgotten: the compaction happened either way.
    this.turnEnded(agentId);
    for (const tracker of Object.values(this.#phases)) tracker.dispose(agentId);
    // A relaunch is a new attempt at the same session's problem: it may say so again.
    this.#resetNoticeSent.delete(agentId);
  }

  /** Forgets every Agent's open phases; used on full daemon shutdown. */
  disposeAll(): void {
    for (const agentId of [...this.#endedCompactions.keys()]) this.turnEnded(agentId);
    for (const tracker of Object.values(this.#phases)) tracker.disposeAll();
  }
}
