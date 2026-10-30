import type { WeeklyReportMessageSuggestion } from "#src/features/records/weekly-report-message-card";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";
import type { ForwardedMessageView } from "./message-forward";
import { GROUPING_WINDOW_MS } from "./conversation-pane-layout";
import { dayLabel } from "./message-dividers";
import type { ReactionSummary } from "./message-reactions";

/** A message as a conversation's rows show it. */
export type MessageView = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderMemberId?: string | null;
  /** What the reader sees: a display name, falling back to the handle (Slack's convention). */
  senderName: string;
  /** The handle behind that name, kept separate because a display name is not an identity.
   * Absent for a server-authored message. */
  senderHandle?: string;
  /** The sender's Agent id, present only when `senderKind === "agent"`; opens the Agent profile
   * panel (`features/agents/profile-panel/`) from the avatar or the sender name. */
  senderAgentId?: string;
  /** The sender's user id, present only when `senderKind === "user"`; opens their profile panel. */
  senderUserId?: string;
  /** True when the sending Agent has since been archived (deleted): the sender renders greyed
   * with an `ARCHIVED` marker, and opens its read-only profile. */
  senderDeleted?: boolean;
  senderAvatarUrl?: string | null;
  body: string;
  createdAt: Date | string;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: AttachmentView[];
  /** Resolved mention rows for the body's embedded `<@kind:uuid>` tokens; absent/empty for
   * DMs and pre-token history, which render as written (token-only highlight by design). */
  mentions?: {
    kind: "user" | "agent";
    actorId: string;
    handle: string;
    label: string;
  }[];
  reactions?: ReactionSummary[];
  /** Present when this message is the summary posted for an Agent-prepared action card.
   * Replaces the plain-text draft hint line with the interactive card; the
   * underlying `body` stays available to assistive technology. */
  actionCard?: ActionCardView;
  /** Present when this message is a forward: the frozen original its card shows. The message's
   * own `body` is then the forwarder's note and its `attachments` the card's. */
  forwarded?: ForwardedMessageView;
  weeklyReportSuggestion?: WeeklyReportMessageSuggestion;
  weeklyReportDisplayBody?: string;
  /** Platform wake stored for the Agent. The conversation pane omits the row. */
  weeklyReportHidden?: boolean;
};

/** Whether two consecutive messages collapse into one visual group. */
export function groupsWithPrevious(
  message: MessageView,
  previous: MessageView | undefined,
  own: boolean,
  previousOwn: boolean,
  locale?: string,
  timeZone?: string,
) {
  if (!previous) return { dayChanged: true, grouped: false };
  const dayChanged =
    dayLabel(previous.createdAt, locale, timeZone) !==
    dayLabel(message.createdAt, locale, timeZone);
  const sameSender =
    !dayChanged &&
    previousOwn === own &&
    (previous.senderMemberId ?? previous.senderName) ===
      (message.senderMemberId ?? message.senderName);
  const grouped =
    sameSender &&
    Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) <=
      GROUPING_WINDOW_MS;
  return { dayChanged, grouped };
}
