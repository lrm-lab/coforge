import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import {
  isBusyTone,
  presentActivity,
  STOPPED_STATUS_DETAIL,
  SUBAGENT_WORKING,
} from "./agent-activity-presentation";

/** Shapes both of `agentDisplay`'s branches alike: most displays carry neither field. */
const NO_CAPTION: { statusDetail?: string; alert?: boolean } = {};

/**
 * Format a cloud decision. No clocks, process facts or history reduction here.
 *
 * `stopped` (a user-persisted intent, not a display fact) never changes `isOnline` or
 * `label` — the Start/Stop button choice and the short status word stay exactly what the Daemon
 * reports. It only adds `statusDetail`, a caption shown only when the display itself is already
 * offline: normally the un-internationalized "Stopped — …" sentence, or — when the cloud display
 * carries a `billing_exhausted` stop reason — the localized quota guidance instead (the provider's
 * words replace the status word). A stopped Agent whose Daemon has not yet caught up is still
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
  // A runtime failure that stopped the Agent with no reset (billing_exhausted) keeps its reason
  // on the offline display; the status word names it and the caption says what to do.
  const quotaExhausted = display.stopReason === "billing_exhausted";
  const label = quotaExhausted
    ? m.agent_status_quota_exhausted()
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
    ...(quotaExhausted
      ? { statusDetail: m.agent_status_quota_exhausted_detail(), alert: true }
      : options?.stopped === true && kind === "offline"
        ? { statusDetail: STOPPED_STATUS_DETAIL }
        : NO_CAPTION),
  };
}
