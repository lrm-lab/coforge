import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type AgentActivity,
  type AgentActivityKind,
} from "@lrm/coforge-sdk/internal";

// Busy-but-filler detail kinds. Like runtime_progress, these only
// renew the display lease; they carry no content worth showing or keeping.
export const LIVENESS_ONLY_DETAIL_KINDS: ReadonlySet<string> = new Set([
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
]);

// "runtime_starting" and "working" are dropped: nothing in the daemon ever
// emits either detail kind. The daemon has exactly one spawn moment, already
// reported as "starting"; "checking_messages" stays for a sibling branch.
const workingKinds = new Set([
  "model_request_started",
  "message_received",
  "model_response_started",
  "running_command",
  "tool_started",
  "freshness_hold",
  "runtime_progress",
  "runtime_reconnecting",
  // A stored native session was unusable and the daemon is cold-starting a new one.
  "runtime_unavailable",
  "starting",
  "checking_messages",
  "compacting_context",
  // Liveness-only fillers: still "working" while visible.
  "tool_end",
  "thinking_end",
  "compaction_finished",
  "review_finished",
  // Visible, stored busy detail kinds.
  "subagent_activity",
  // The Agent's provider entered a review pass.
  "reviewing_changes",
  // Compaction/review started and no finish was observed for a long time.
  "compaction_stale",
  "review_stale",
  // The daemon is restarting a provider it found stalled.
  "stalled_recovery",
  // The daemon injected a system/control message into the Agent's session.
  "system_message",
]);

export function activityKindForObservation(
  observation: Pick<AgentActivity, "detailKind" | "level">,
): Exclude<AgentActivityKind, "offline"> | undefined {
  if (
    observation.level === "error" ||
    observation.detailKind === "runtime_error" ||
    observation.detailKind === "runtime_crashed" ||
    // The provider has produced nothing for too long while work is pending;
    // follows how runtime_error/runtime_crashed map above.
    observation.detailKind === "runtime_stalled"
  )
    return "error";
  if (observation.detailKind === "thinking_started") return "thinking";
  if (observation.detailKind === "idle" || observation.detailKind === "runtime_interrupted")
    return "online";
  if (workingKinds.has(observation.detailKind)) return "working";
  return undefined;
}
