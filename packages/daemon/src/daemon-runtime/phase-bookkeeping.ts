import type { AgentRuntimeEvent } from "@coforge/agent";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { PhaseTracker } from "#src/agent-runtime/phase-tracker";
import {
  inferredCompactionFinish,
  RUNTIME_PHASES,
  type CompactionInference,
  type PhaseActivity,
  type RuntimePhase,
} from "#src/agent-runtime/runtime-phases";
import type { ActivityLaunch } from "./activity-launch";
import type { ActivityDraft, PublishedActivityLaunch } from "./agent-activity-publisher";

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
}>;

/**
 * Whether each phase is open per Agent, and its stale watchdog. A compaction also ends,
 * inferred, on resumed output, a new tool call, or the turn's end. A review does not end on
 * output or a tool call, since it is made of both; the turn's end closes it without a row.
 */
export class PhaseBookkeeping {
  readonly #phases: Readonly<Record<RuntimePhase, PhaseTracker>>;

  constructor(private readonly ports: PhaseBookkeepingPorts) {
    this.#phases = {
      compaction: this.#track("compaction"),
      review: this.#track("review"),
    };
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
  }

  /** Ends an open phase once on its own finish signal. */
  finish(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    if (this.#phases[phase].finish(agentId) !== "finished") return;
    this.#publish(agentId, launch, RUNTIME_PHASES[phase].finished, conversation);
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
  }

  /** Ends an open phase once as interrupted, for a phase that reports interruptions. */
  interrupt(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    const interrupted = RUNTIME_PHASES[phase].interrupted;
    if (!interrupted || this.#phases[phase].interrupt(agentId) !== "interrupted") return;
    this.#publish(agentId, launch, interrupted, conversation);
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
  }

  /** Forgets every Agent's open phases; used on full daemon shutdown. */
  disposeAll(): void {
    for (const tracker of Object.values(this.#phases)) tracker.disposeAll();
  }
}
