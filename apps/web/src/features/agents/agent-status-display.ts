import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  stopNeedsPerson,
  stopRecovery,
} from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import { stopReasonCopy } from "./agent-stop-reason";
import {
  isBusyTone,
  presentActivity,
  STOPPED_STATUS_DETAIL,
  SUBAGENT_WORKING,
} from "./agent-activity-presentation";

/** Shapes both of `agentDisplay`'s branches alike: most displays carry neither field. */
const NO_CAPTION: {
  statusDetail?: string;
  alert?: boolean;
  alertText?: string;
  /** What gets the Agent going again, when a person has to act (`STOP_REASON_RECOVERY`). */
  recovery?: "retry" | "reset_session";
} = {};

/**
 * Format a cloud decision. No clocks, process facts or history reduction here.
 *
 * `stopped` (a user-persisted intent, not a display fact) never changes `isOnline` or
 * `label` — the Start/Stop button choice and the short status word stay exactly what the Daemon
 * reports. It only adds `statusDetail`, a caption shown only when the display itself is already
 * offline: normally the un-internationalized "Stopped — …" sentence, or — when the cloud display
 * carries a stop reason only a person can clear (`stopReasonCopy`) — what to do about it, with the
 * reason as the status word (for `billing_exhausted`, the provider's own words, task #667). A
 * stopped Agent whose Daemon has not yet caught up is still
 * described by its real display kind, not overridden into looking offline early.
 */
export function agentDisplay(display?: AgentDisplaySnapshot, options?: { stopped?: boolean }) {
  if (!display)
    return {
      kind: "unknown" as const,
      label: m.agent_status_unknown(),
      isOnline: undefined,
      tone: "unknown" as const,
      pulse: false,
      ...NO_CAPTION,
    };
  const kind = display.activityKind;
  const row = presentActivity({ ...display, level: kind === "error" ? "error" : "info" }).at(-1);
  // A failure only a person can clear (a quota gone, a runtime signed out) keeps its reason on
  // the offline display; the status word names it and the caption says what to do.
  // Whether a person has to act is the SDK's call for every reason the Daemon has (task #731);
  // our copy only names the ones it has words for.
  const needsPerson = stopNeedsPerson(display.stopReason);
  const reason = needsPerson ? stopReasonCopy(display.stopReason) : undefined;
  // The provider's own words for a quota (Frank, 11-07); our word only where none was kept.
  const providerWords = display.stopReason === "billing_exhausted" ? display.stopDetail : null;
  // The Daemon's own sentence for the stop, as the Activity log shows it (Frank, 11-09: the same
  // words everywhere, nothing of ours); our short word only where none was recorded.
  const stopWords = (needsPerson && display.stopMessage) || providerWords;
  const alertWord = needsPerson ? stopWords || reason?.label() || m.agent_status_offline() : "";
  const label = needsPerson
    ? alertWord
    : kind === "online"
      ? m.agent_status_online()
      : kind === "offline"
        ? m.agent_status_offline()
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
    // `alert`: someone has to act, so the word reads red, with a warning sign (`AgentStatusMarker`).
    ...(needsPerson
      ? {
          ...(reason && { statusDetail: reason.detail() }),
          alert: true,
          // The one line a banner has: the same words, or the short word alone.
          alertText: alertWord,
          recovery: stopRecovery(display.stopReason) as "retry" | "reset_session",
        }
      : options?.stopped === true && kind === "offline"
        ? { statusDetail: STOPPED_STATUS_DETAIL }
        : NO_CAPTION),
  };
}
