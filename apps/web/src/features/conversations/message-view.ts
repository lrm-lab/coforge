import type { WeeklyReportMessageSuggestion } from "#src/features/records/weekly-report-message-card";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";
import type { ForwardedMessageView } from "./message-forward";
import { GROUPING_WINDOW_MS } from "./conversation-pane-layout";
import { dayLabel } from "./message-dividers";
import type { ReactionSummary } from "./message-reactions";
import type { ArtifactCardState } from "#src/features/artifacts/artifact-card";

export type MessageView = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderMemberId?: string | null;
  senderName: string;
  senderHandle?: string;
  senderAgentId?: string;
  senderUserId?: string;
  senderDeleted?: boolean;
  senderAvatarUrl?: string | null;
  body: string;
  systemPeople?: Record<string, { kind: "user" | "agent"; id: string; avatarUrl: string | null }>;
  createdAt: Date | string;
  attachments: AttachmentView[];
  mentions?: {
    kind: "user" | "agent";
    actorId: string;
    handle: string;
    label: string;
  }[];
  reactions?: ReactionSummary[];
  actionCard?: ActionCardView;
  forwarded?: ForwardedMessageView[];
  artifactCards?: ArtifactCardState[];
  weeklyReportSuggestion?: WeeklyReportMessageSuggestion;
  weeklyReportDisplayBody?: string;
  weeklyReportHidden?: boolean;
};

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
    message.senderKind !== "system" &&
    previous.senderKind !== "system" &&
    previousOwn === own &&
    (previous.senderMemberId ?? previous.senderName) ===
      (message.senderMemberId ?? message.senderName);
  const grouped =
    sameSender &&
    Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) <=
      GROUPING_WINDOW_MS;
  return { dayChanged, grouped };
}
