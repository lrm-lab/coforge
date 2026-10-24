import type { AgentRuntimeEvent } from "@coforge/agent";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";

/**
 * The provider-reported phases the daemon runtime tracks, one `PhaseTracker` each
 * (`./phase-tracker.ts`): which normalized events open, close or interrupt each one, and what
 * Activity each reports. The daemon runtime only wires this policy to its trackers.
 */
export type RuntimePhase = "compaction" | "review";
export type PhaseEdge = "start" | "finish" | "interrupt";
/** Why an open compaction is taken as finished without its own finish signal. */
export type CompactionInference = "resumed output" | "resumed tool use" | "turn end";
export type PhaseActivity = readonly [detailKind: AgentActivityDetailKind, detail: string];

/** How long a compaction may stay open with no finish signal before its stale notice. */
export const COMPACTION_STALE_MS = 5 * 60_000;
/** The same for a review pass, which is given longer than a compaction. */
export const REVIEW_STALE_MS = 10 * 60_000;

/** The one table of phase events: each event's phase and the edge it reports. */
export const PHASE_EDGES: ReadonlyMap<
  AgentRuntimeEvent["type"],
  readonly [phase: RuntimePhase, edge: PhaseEdge]
> = new Map<AgentRuntimeEvent["type"], readonly [RuntimePhase, PhaseEdge]>([
  ["compaction-started", ["compaction", "start"]],
  ["compaction-finished", ["compaction", "finish"]],
  ["compaction-interrupted", ["compaction", "interrupt"]],
  ["review-started", ["review", "start"]],
  ["review-finished", ["review", "finish"]],
]);

/** The events that open or close a phase. Each is a boundary for the Activity trajectory (it
 * ends a thinking run and flushes pending text) and turn Activity for the runtime. */
export const PHASE_BOUNDARY_EVENT_TYPES: ReadonlySet<AgentRuntimeEvent["type"]> = new Set(
  PHASE_EDGES.keys(),
);

/**
 * What each phase reports: its start, its explicit finish, its interruption (a provider signal
 * that does not say whether it was aborted or failed - a failure also arrives as its own error -
 * so the row says only that it did not complete), and the one notice its watchdog sends
 * `staleMs` after a start with no finish.
 */
export const RUNTIME_PHASES: Readonly<
  Record<
    RuntimePhase,
    {
      staleMs: number;
      started: PhaseActivity;
      finished: PhaseActivity;
      interrupted?: PhaseActivity;
      stale: PhaseActivity;
    }
  >
> = {
  compaction: {
    staleMs: COMPACTION_STALE_MS,
    started: [AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT, "Compacting context"],
    finished: [AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED, "Context compaction finished"],
    interrupted: [
      AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
      "Context compaction interrupted; completion was not confirmed",
    ],
    stale: [
      AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE,
      "Context compaction still running; no finish event observed",
    ],
  },
  review: {
    staleMs: REVIEW_STALE_MS,
    started: [AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES, "Reviewing changes"],
    finished: [AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED, "Review finished"],
    stale: [
      AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE,
      "Review mode still active; no finish event observed",
    ],
  },
};

/** The finish row of a compaction inferred from `inference`. */
export function inferredCompactionFinish(inference: CompactionInference): PhaseActivity {
  return [
    AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
    `Context compaction finished (inferred from ${inference})`,
  ];
}

/** The provider events that show a turn at work: they keep an Agent busy and a stale idle claim
 * is reconciled before they are reported. */
export const TURN_ACTIVITY_EVENT_TYPES = new Set<AgentRuntimeEvent["type"]>([
  "text-delta",
  "thinking-delta",
  "tool-start",
  "tool-output",
  "tool-end",
  "progress",
  "reconnecting",
  ...PHASE_BOUNDARY_EVENT_TYPES,
]);
