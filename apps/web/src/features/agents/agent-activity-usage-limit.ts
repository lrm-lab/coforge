import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { formatRelativeTime } from "#src/lib/dates";
import type { ActivityObservation, PresentedActivityRow } from "./agent-activity-presentation";

/** The marks a status atom carries for the usage-limit episode merge (task #575). */
export type UsageLimitAtomMarks = {
  usageLimit?: { resetsAt?: string };
  usageLimitFiller?: boolean;
};

/** The daemon's reset suffix on a runtime_error detail (`limitResetNote` in the daemon's
 * runtime-error-activity.ts): the ISO time the provider named, when it named one. */
const LIMIT_RESET_SUFFIX = /\(limit resets at ([^)]+)\)\s*$/;

function limitResetAt(detail: string): string | undefined {
  const resetsAt = LIMIT_RESET_SUFFIX.exec(detail)?.[1];
  return resetsAt && Number.isFinite(Date.parse(resetsAt)) ? resetsAt : undefined;
}

/** The usage-limit fact a runtime_error observation carries, when its classified reason is a
 * quota exhaustion the daemon keeps retrying: `quota_exhausted` covers provider limits and
 * window-limit wording alike (task #575; Raft's `noteUsageLimit`). */
function observationUsageLimit(
  observation: ActivityObservation,
): { resetsAt?: string } | undefined {
  if (
    observation.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR ||
    observation.runtimeError?.errorReason !== "quota_exhausted"
  )
    return undefined;
  const resetsAt = limitResetAt(observation.detail);
  return resetsAt ? { resetsAt } : {};
}

/** Status detail kinds that may appear between two retries of one usage-limit episode without
 * breaking it: pure liveness and turn scaffolding, never user or agent content. */
const USAGE_LIMIT_EPISODE_FILLER = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.IDLE,
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING,
]);

/** The episode marks of one status atom: a usage-limit error, or filler an open episode
 * absorbs. Content atoms (entry-mapped) never carry them — callers apply this only to
 * status-path atoms. */
export function usageLimitAtomMarks(observation: ActivityObservation): UsageLimitAtomMarks {
  if (observation.level === "error") {
    const usageLimit = observationUsageLimit(observation);
    return usageLimit ? { usageLimit } : {};
  }
  return USAGE_LIMIT_EPISODE_FILLER.has(observation.detailKind) ? { usageLimitFiller: true } : {};
}

/** The one row a run of consecutive usage-limit retries presents as (task #575; Raft's merged
 * "Usage limit reached · resets … · N attempts"): the run's position and identity, the newest
 * known reset, and how many attempts it has seen. */
export function usageLimitEpisodeRow(
  base: {
    conversationId?: string | null;
    conversationTarget?: string | null;
    observedAtMs: number;
    key: string;
  },
  attempts: number,
  resetsAt: string | undefined,
): PresentedActivityRow {
  const detail = `${resetsAt ? `resets ${formatRelativeTime(resetsAt)}` : "reset time unknown"} · ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  return {
    label: "Usage limit reached",
    detail,
    recentLabel: `Usage limit reached: ${detail}`,
    currentLabel: null,
    tone: "error",
    recentTone: "error",
    detailOnOwnLine: false,
    expandable: false,
    observedAtMs: base.observedAtMs,
    key: base.key,
    conversationId: base.conversationId,
    conversationTarget: base.conversationTarget,
  };
}
