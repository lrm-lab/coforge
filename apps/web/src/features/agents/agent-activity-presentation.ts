import type { ActivityEntry } from "./agent-activity";
import type {
  ActivitySubagent,
  AgentDisplaySnapshot,
  ActivityTrajectoryEntry,
} from "@lrm/coforge-sdk/internal";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  TOOL_LABELS,
  canonicalToolName,
  toolActivityLabel,
} from "@lrm/coforge-sdk/internal";
import type { StatusTone } from "#src/components/ui/status-dot";
import { m } from "#src/paraglide/messages";

export type ActivityObservation = Pick<
  ActivityEntry,
  "activityKind" | "detailKind" | "detail" | "level" | "entries"
>;
/** Agent activity tones; `online` is a Computer-only presence tone (see `StatusDot`). */
export type ActivityTone = Exclude<StatusTone, "online">;
type Tone = ActivityTone;
/** Activity labels are not internationalized (AGENTS.md); reused verbatim for the persisted
 * "user stopped this Agent" status text, not just the offline-history activity row. */
export const STOPPED_STATUS_DETAIL = "Stopped — won't receive messages until restarted";
export type ActivityRow = {
  label: string;
  detail: string;
  recentLabel: string;
  currentLabel: string | null;
  tone: Tone;
  recentTone: Tone;
  /** Tool input and text/thinking/system statements go on a line under the label; a status
   * row's secondary text stays inline after it. */
  detailOnOwnLine: boolean;
  expandable: boolean;
  subagent?: ActivitySubagent;
};

/** The Agent's current label while a subagent works, whatever row its frame shows. */
const SUBAGENT_WORKING = "Subagent working…";

/** A subagent row's badge: the provider's subagent type when the daemon reported one. */
export function subagentBadgeLabel(subagent: ActivitySubagent): string {
  return subagent.subagentType ? `Subagent: ${subagent.subagentType}` : "Subagent";
}

/**
 * tool_end, thinking_end and compaction_finished are entry-less status
 * frames that are now persisted and shown live like any other Activity. Their primary label
 * still comes from the ordinary activity-kind classification above (`activityKindForObservation`
 * on the server puts all three under "working", so the primary label reads "Working" the same as
 * any other busy frame). Current daemons send their own secondary text in `detail` ("Tool
 * finished", "Thinking finished"); this map's `label` is only the fallback wording for an empty
 * `detail` (older daemons, and rows stored before the daemon started sending text), and its
 * `recentTone` the dot the Agent card's Recent activity gives the row when it differs from the
 * frame's own (a finished compaction reads as the Agent settling back, not another busy step).
 * `runtime_progress` has no entry here — it stays a content-free liveness filler, never
 * persisted or shown in the timeline (`decodeActivityObservation` drops it, `mergeAgentActivity`
 * again as a guard), so falling through to its empty raw `detail` below (no secondary text at
 * all) is correct for it too.
 */
const FINISHED_STATUS: Readonly<Record<string, { label: string; recentTone?: Tone }>> = {
  [AGENT_ACTIVITY_DETAIL_KIND.TOOL_END]: { label: "Tool finished" },
  [AGENT_ACTIVITY_DETAIL_KIND.THINKING_END]: { label: "Thinking finished" },
  [AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED]: {
    label: "Compaction finished",
    recentTone: "idle",
  },
  [AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED]: { label: "Review finished" },
};

/** Computer lifecycle rows the server writes into each of a Computer's Agents' Activity. Only a
 * failed operation shows the row's detail; the others read as their label alone, including rows
 * stored while the server still wrote a detail for them. */
const COMPUTER_LIFECYCLE: Readonly<
  Record<string, { label: string; tone: Tone; showsDetail?: true }>
> = {
  [AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_DISCONNECTED]: { label: "Disconnected", tone: "offline" },
  [AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_STARTED]: { label: "Started", tone: "idle" },
  [AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_RESTARTED]: { label: "Restarted", tone: "idle" },
  [AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_UPGRADED]: { label: "Upgraded", tone: "idle" },
  [AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_OPERATION_FAILED]: {
    label: "Computer operation failed",
    tone: "error",
    showsDetail: true,
  },
};

/** Working and thinking are the busy tones: an Agent avatar's status dot pulses for them. */
function isBusyTone(tone: StatusTone): boolean {
  return tone === "working" || tone === "thinking";
}

/** One atom of a presented activity frame: 0 or 1 visible row, plus (for text/thinking
 * atoms only) a `mergeGroup` naming the contiguous statement it belongs to. A hidden
 * `send_message` tool call has no row and no `mergeGroup` — it still occupies a slot in
 * the atom sequence, so `presentActivityRows` sees it as a real boundary between two
 * separate statements even though nothing renders for it. */
type ActivityAtom = { row?: ActivityRow; mergeGroup?: string };

function presentEntryItem(
  item: ActivityTrajectoryEntry,
  kind: string,
  detail: string,
): ActivityAtom {
  if (item.kind === "tool_start") {
    const { canonical, name } = canonicalToolName(item.toolName);
    if (canonical === "send_message") return {};
    const label = TOOL_LABELS[canonical] ?? name;
    return {
      row: {
        label,
        // The already-redacted argument summary; the frame's own `detail` is only
        // the generic label and would repeat `label`.
        detail: item.toolInput ?? "",
        recentLabel: label,
        currentLabel: toolActivityLabel(item.toolName),
        tone: "working",
        recentTone: "working",
        detailOnOwnLine: true,
        expandable: false,
        subagent: item.subagent,
      },
    };
  }
  if (item.kind === "system") {
    // A daemon-injected system/control message. Never merged with a
    // neighbouring text/thinking row: returning no `mergeGroup` closes
    // whatever statement merge group was open before it.
    return {
      row: {
        label: item.title,
        detail: item.text,
        recentLabel: item.title,
        currentLabel: item.title,
        tone: "output",
        recentTone: "working",
        detailOnOwnLine: true,
        expandable: true,
        subagent: item.subagent,
      },
    };
  }
  const thinking = item.kind === "thinking";
  return {
    row: {
      label: thinking ? "Thinking" : "Output",
      detail: item.text,
      recentLabel: item.text || (thinking ? "Thinking" : "Output"),
      currentLabel: thinking
        ? "Thinking…"
        : kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING ||
            kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE
          ? detail || "Working…"
          : "Working…",
      tone: thinking ? "thinking" : "output",
      recentTone: thinking ? "thinking" : "working",
      detailOnOwnLine: true,
      expandable: true,
    },
    // A subagent's statement shows no badge (only its tool, system and status rows do), but
    // never merges with the main Agent's or another subagent's.
    mergeGroup: `${thinking ? "thinking" : "text"}:${item.subagent?.parentToolUseId ?? ""}`,
  };
}

function activityAtoms(observation: ActivityObservation): ActivityAtom[] {
  const { detailKind: kind, level, detail } = observation;
  if (
    kind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED &&
    level !== "error" &&
    (!detail || detail === "Waiting for model response")
  ) {
    const label = m.agent_activity_waiting_model();
    return [
      {
        row: {
          label,
          detail: "",
          recentLabel: label,
          currentLabel: label,
          tone: "working",
          recentTone: "working",
          detailOnOwnLine: false,
          expandable: false,
        },
      },
    ];
  }
  // The daemon reclassifies a frame with subagent-scoped entries as subagent_activity. Its
  // entries show as their own rows, as the main Agent's do (tool and system rows carry the
  // subagent badge); the Agent's current label stays the one "Subagent working…" signal. A
  // subagent progress row has no entries: its phase ("Subagent started (Explore)") is its detail.
  if (kind === AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY && level !== "error") {
    if (observation.entries?.length)
      return observation.entries.map((entry) => {
        const atom = presentEntryItem(entry, kind, detail);
        return atom.row ? { ...atom, row: { ...atom.row, currentLabel: SUBAGENT_WORKING } } : atom;
      });
    return [
      {
        row: {
          label: "Subagent working",
          detail,
          recentLabel: SUBAGENT_WORKING,
          currentLabel: SUBAGENT_WORKING,
          tone: "working",
          recentTone: "working",
          detailOnOwnLine: false,
          expandable: false,
        },
      },
    ];
  }
  const lifecycle = COMPUTER_LIFECYCLE[kind];
  if (lifecycle) {
    const lifecycleDetail = lifecycle.showsDetail ? detail : "";
    return [
      {
        row: {
          label: lifecycle.label,
          detail: lifecycleDetail,
          recentLabel: lifecycleDetail ? `${lifecycle.label}: ${lifecycleDetail}` : lifecycle.label,
          currentLabel: null,
          tone: lifecycle.tone,
          recentTone: lifecycle.tone,
          detailOnOwnLine: false,
          expandable: false,
        },
      },
    ];
  }
  if (level !== "error") {
    const entries = observation.entries ?? [];
    if (entries.length) return entries.map((entry) => presentEntryItem(entry, kind, detail));
  }
  const tone: Tone =
    level === "error"
      ? "error"
      : observation.activityKind === "online"
        ? "idle"
        : (observation.activityKind ?? "unknown");
  const starting = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.STARTING;
  const compacting = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT;
  const reviewing = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES;
  const compactionStale =
    tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE;
  const reviewStale = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE;
  const stalledRecovery =
    tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY;
  const stalled = tone === "error" && kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED;
  const label =
    tone === "error"
      ? stalled
        ? "Stalled"
        : "Error"
      : starting
        ? "Starting"
        : compacting
          ? "Compacting context"
          : reviewing
            ? "Reviewing changes"
            : compactionStale
              ? "Compaction still running"
              : reviewStale
                ? "Review still running"
                : stalledRecovery
                  ? "Restarting stalled provider"
                  : tone === "working"
                    ? "Working"
                    : tone === "thinking"
                      ? "Thinking"
                      : tone === "idle"
                        ? "Idle"
                        : tone === "offline"
                          ? "Stopped"
                          : "Activity";
  // Completion rows prefer the daemon's own detail ("Tool finished") and fall back to
  // FINISHED_STATUS for frames reported or stored with an empty one.
  const finished = FINISHED_STATUS[kind];
  const statusSecondary = finished ? detail || finished.label : undefined;
  const recentLabel =
    tone === "working"
      ? starting
        ? "Starting…"
        : compacting
          ? "Compacting context…"
          : reviewing
            ? "Reviewing changes…"
            : compactionStale
              ? "Compaction still running…"
              : reviewStale
                ? "Review still running…"
                : stalledRecovery
                  ? "Restarting stalled provider…"
                  : (statusSecondary ?? (detail || "Working…"))
      : tone === "thinking"
        ? "Thinking…"
        : tone === "idle"
          ? "Online"
          : tone === "offline"
            ? STOPPED_STATUS_DETAIL
            : tone === "error"
              ? detail
                ? `${label}: ${detail}`
                : label
              : detail || label;
  const secondary =
    statusSecondary ?? (starting || (tone === "offline" && detail === "Stopped") ? "" : detail);
  return [
    {
      row: {
        label,
        // A detail that only repeats the label ("Idle", "Compacting context") adds nothing.
        detail: secondary.toLowerCase() === label.toLowerCase() ? "" : secondary,
        recentLabel,
        currentLabel: isBusyTone(tone) ? recentLabel : null,
        tone,
        recentTone: finished?.recentTone ?? tone,
        detailOnOwnLine: false,
        expandable: false,
      },
    },
  ];
}

/** Display-only projection: never derive Agent availability from these tones. */
export function presentActivity(observation: ActivityObservation): ActivityRow[] {
  return activityAtoms(observation).flatMap((atom) => (atom.row ? [atom.row] : []));
}

export type PresentedActivityRow = ActivityRow & {
  observedAtMs: number;
  key: string;
  conversationId?: string | null;
  conversationTarget?: string | null;
};

/**
 * `presentActivity` per activity frame, plus one merge: consecutive text (or thinking)
 * atoms of the same launch and subagent lineage, with nothing else between them in the
 * true entry sequence (not just the visible rows — a hidden `send_message` tool call
 * still separates them), render as one row. Its text is every fragment concatenated
 * oldest-to-newest with no separator (they are contiguous slices of one stream), its
 * timestamp and key come from the oldest fragment (stable identity while later
 * fragments stream in and extend it), and `currentLabel` reflects the newest fragment.
 * `activity` is newest-first (`orderActivity`); the rows come out oldest first, the order every
 * reader shows them in.
 */
export function presentActivityRows(activity: readonly ActivityEntry[]): PresentedActivityRow[] {
  const chronological = [...activity].reverse().flatMap((entry) =>
    activityAtoms(entry).map((atom, itemIndex) => ({
      row: atom.row,
      conversationId: entry.conversationId,
      conversationTarget: entry.conversationTarget,
      mergeGroup: atom.mergeGroup
        ? `${entry.launchId}:${entry.conversationId ?? ""}:${atom.mergeGroup}`
        : undefined,
      observedAtMs: entry.observedAtMs,
      key: `${entry.launchId}:${entry.clientSeq}:${itemIndex}`,
    })),
  );
  const merged: PresentedActivityRow[] = [];
  let openGroup: string | undefined;
  for (const atom of chronological) {
    if (atom.mergeGroup && atom.mergeGroup === openGroup) {
      const last = merged[merged.length - 1];
      const detail = last.detail + (atom.row?.detail ?? "");
      merged[merged.length - 1] = {
        ...last,
        detail,
        recentLabel: detail || last.label,
        currentLabel: atom.row?.currentLabel ?? last.currentLabel,
      };
    } else if (atom.row) {
      merged.push({
        ...atom.row,
        observedAtMs: atom.observedAtMs,
        key: atom.key,
        conversationId: atom.conversationId,
        conversationTarget: atom.conversationTarget,
      });
    }
    openGroup = atom.mergeGroup;
  }
  return merged;
}

/**
 * Format a cloud decision. No clocks, process facts or history reduction here.
 *
 * `stopped` (a user-persisted intent, not a display fact) never changes `isOnline` or
 * `label` — the Start/Stop button choice and the short status word stay exactly what the Daemon
 * reports. It only adds `statusDetail`, an un-internationalized caption (AGENTS.md) reusing the
 * existing Activity "Stopped — …" sentence, shown only when the display itself is already
 * offline: a stopped Agent whose Daemon has not yet caught up is still described by its real
 * display kind, not overridden into looking offline early.
 */
export function agentDisplay(display?: AgentDisplaySnapshot, options?: { stopped?: boolean }) {
  if (!display)
    return {
      kind: "unknown" as const,
      label: "Status unknown",
      isOnline: undefined,
      tone: "unknown" as const,
      pulse: false,
      // Never present; only shapes the inferred type to match the other branch's optional field.
      ...((false as boolean) ? { statusDetail: "" } : {}),
    };
  const kind = display.activityKind;
  const row = presentActivity({ ...display, level: kind === "error" ? "error" : "info" }).at(-1);
  const label =
    kind === "online"
      ? "Online"
      : kind === "offline"
        ? "Offline"
        : kind === "thinking"
          ? "Thinking…"
          : kind === "error"
            ? (row?.recentLabel ?? "Error")
            : (row?.currentLabel ??
              // A subagent frame whose only entry is hidden (`send_message`) has no row.
              (display.detailKind === AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY
                ? SUBAGENT_WORKING
                : "Working…"));
  return {
    kind,
    label,
    isOnline: kind !== "offline",
    tone: kind === "online" ? ("idle" as const) : kind,
    pulse: isBusyTone(kind),
    ...(options?.stopped === true && kind === "offline"
      ? { statusDetail: STOPPED_STATUS_DETAIL }
      : {}),
  };
}
