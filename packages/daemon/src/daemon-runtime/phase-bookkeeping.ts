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
  /** The Agent's last context-usage reading: a compaction's token numbers, when one was observed. */
  contextUsage?(agentId: string): { usedTokens: number; windowTokens: number } | undefined;
}>;

/**
 * Whether each phase is open per Agent, and its stale watchdog. A compaction also ends,
 * inferred, on resumed output, a new tool call, or the turn's end. A review does not end on
 * output or a tool call, since it is made of both; the turn's end closes it without a row.
 */
export class PhaseBookkeeping {
  readonly #phases: Readonly<Record<RuntimePhase, PhaseTracker>>;
  /** Where each open compaction started, in tokens, for the one line it logs when it ends. */
  readonly #compactionBefore = new Map<string, number | undefined>();
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
  #logCompactionTokens(
    agentId: string,
    outcome: "finished" | "inferred" | "interrupted",
    reported?: CompactionTokens,
    interruption?: CompactionInterruption,
  ): void {
    const observedBefore = this.#compactionBefore.get(agentId);
    this.#compactionBefore.delete(agentId);
    this.#compactionAttempts.delete(agentId);
    const usage = this.ports.contextUsage?.(agentId);
    logger.info("Context compaction ended", {
      event: "agent.runtime.compaction_tokens",
      agent_id: agentId,
      outcome,
      tokens_before: reported?.tokensBefore ?? observedBefore,
      tokens_after: reported?.tokensAfter ?? usage?.usedTokens,
      window_tokens: reported?.windowTokens ?? usage?.windowTokens,
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
    if (phase === "compaction")
      this.#compactionBefore.set(agentId, this.ports.contextUsage?.(agentId)?.usedTokens);
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
      this.#logCompactionTokens(agentId, "finished", reported);
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
    this.#logCompactionTokens(agentId, "inferred");
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
    this.#logCompactionTokens(agentId, "interrupted", undefined, interruption);
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
        "Context compaction failed repeatedly; reset the session from the Agent page (Reset Session & Restart).",
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
    for (const tracker of Object.values(this.#phases)) tracker.dispose(agentId);
    // A relaunch is a new attempt at the same session's problem: it may say so again.
    this.#resetNoticeSent.delete(agentId);
  }

  /** Forgets every Agent's open phases; used on full daemon shutdown. */
  disposeAll(): void {
    for (const tracker of Object.values(this.#phases)) tracker.disposeAll();
  }
}
