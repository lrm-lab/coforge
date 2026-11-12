import { APP_BOT_LOGO_SELECT } from "#src/server/apps/app-logo.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  attachmentView,
  ATTACHMENT_VIEW_SELECT,
} from "#src/server/attachments/attachment-view.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT, browserMessageMention } from "./mentions.server";
import { MESSAGE_REACTIONS_SELECT, reactionSummaries } from "./message-reactions.server";
import {
  browserSenderAvatarUrl,
  browserSenderHandle,
  browserSenderName,
} from "./sender-display.server";
import type { ActionCardView } from "./action-cards.server";
import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import { BROWSER_FORWARD_SELECT, browserForwarded } from "./message-forward-view.server";
import {
  isWeeklyReportPlatformTurn,
  weeklyReportAssistantDisplayBody,
} from "#src/server/records/weekly-report-assistant-request.server";
import {
  parseWeeklyReportAssistantSuggestion,
  weeklyReportAssistantSuggestionDisplayBody,
} from "#src/server/records/weekly-report-assistant-suggestion.server";
import {
  noticeFacesOf,
  systemNoticeFaces,
  type SystemPersonFace,
} from "./system-notice-people.server";

/** The row shape the Saved list (#120/#124) shares, so it renders exactly like the stream. */
export const browserMessageFields = {
  id: true,
  sequence: true,
  threadRootId: true,
  senderMemberId: true,
  body: true,
  createdAt: true,
  attachments: {
    // Which original of a forward of several each copy is of.
    select: { ...ATTACHMENT_VIEW_SELECT, forwardPosition: true },
    orderBy: { position: "asc" as const },
  },
  sender: {
    select: {
      userId: true,
      agentId: true,
      user: {
        select: { username: true, displayName: true, avatarObjectKey: true },
      },
      agent: {
        select: {
          name: true,
          displayName: true,
          deletedAt: true,
          avatarMascot: true,
          appBot: APP_BOT_LOGO_SELECT,
        },
      },
    },
  },
  mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
  // The version is a column of the message row, which Prisma reads in the same statement as the
  // reactions or before them, never after: it may understate the summary beside it, never
  // overstate it, so the page still shows any newer `message.reaction.v1` it hears.
  reactionVersion: true,
  reactions: MESSAGE_REACTIONS_SELECT,
  // The snapshots a forwarded message carries, in order; none for every other message.
  forwards: BROWSER_FORWARD_SELECT,
  // A server notice's structured kind and parameters; null for every other message.
  systemMessage: { select: { kind: true, params: true } },
} satisfies Prisma.MessageSelect;

export type BrowserMessageRow = Prisma.MessageGetPayload<{
  select: typeof browserMessageFields;
}>;

/**
 * How many comments each attachment of these messages has (task #238), in one indexed query for
 * the whole page rather than one per attachment. Every comment on the file counts, a reply
 * included: each has its `AttachmentComment` row.
 */
export async function attachmentCommentCounts(
  db: Pick<PrismaClient, "attachmentComment">,
  messages: readonly { attachments: readonly { id: string }[] }[],
): Promise<ReadonlyMap<string, number>> {
  const attachmentIds = messages.flatMap((message) => message.attachments.map(({ id }) => id));
  if (attachmentIds.length === 0) return new Map();
  const rows = await db.attachmentComment.groupBy({
    by: ["attachmentId"],
    where: { attachmentId: { in: attachmentIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.attachmentId, row._count._all]));
}

/** A page of messages for the stream, with their attachments' comment counts. */
export async function mapBrowserMessages(
  db: Pick<PrismaClient, "attachmentComment" | "conversationMember">,
  messages: readonly BrowserMessageRow[],
  workspaceId: string,
) {
  const [commentCounts, noticeFaces] = await Promise.all([
    attachmentCommentCounts(db, messages),
    systemNoticeFaces(db, messages, workspaceId),
  ]);
  return messages.map((message) =>
    mapBrowserMessage(message, workspaceId, commentCounts, noticeFaces),
  );
}

/** Exported for a pure unit test of this projection (no database needed). Channels and direct
 * conversations share it whole: `senderMemberId` is how a pane tells the viewer's own messages. */
export function mapBrowserMessage(
  message: BrowserMessageRow,
  workspaceId: string,
  /** The attachments' comment counts, from `attachmentCommentCounts`; a surface that shows no
   * file cards leaves them out. */
  commentCounts?: ReadonlyMap<string, number>,
  /** The faces of the people a notice names (`systemNoticeFaces`); a surface that shows no
   * notices leaves them out. */
  noticeFaces?: ReadonlyMap<string, SystemPersonFace>,
) {
  const suggestion = message.sender?.agentId
    ? parseWeeklyReportAssistantSuggestion(message.body)
    : null;
  const weeklyReportSuggestion =
    suggestion?.type === "collect-plan" ||
    suggestion?.type === "body-edit" ||
    suggestion?.type === "send-prompt"
      ? suggestion
      : null;
  const fromUser = Boolean(message.sender?.userId);
  const weeklyReportHidden = fromUser && isWeeklyReportPlatformTurn(message.body);
  const contextDisplay = fromUser ? weeklyReportAssistantDisplayBody(message.body) : "";
  const weeklyReportDisplayBody = weeklyReportSuggestion
    ? weeklyReportAssistantSuggestionDisplayBody(message.body)
    : fromUser && !weeklyReportHidden && contextDisplay !== message.body.trim()
      ? contextDisplay
      : undefined;
  return {
    ...(weeklyReportSuggestion ? { weeklyReportSuggestion } : {}),
    ...(weeklyReportDisplayBody ? { weeklyReportDisplayBody } : {}),
    ...(weeklyReportHidden ? { weeklyReportHidden: true as const } : {}),
    id: message.id,
    sequence: message.sequence,
    threadRootId: message.threadRootId ?? undefined,
    senderMemberId: message.senderMemberId,
    senderKind: !message.sender
      ? ("system" as const)
      : message.sender.userId
        ? ("user" as const)
        : ("agent" as const),
    senderName: browserSenderName(message.sender),
    senderHandle: browserSenderHandle(message.sender),
    /** The sender's Agent id, present only for an Agent-sent message; opens the Agent profile
     * panel from a message row (`features/agents/profile-panel/`). */
    senderAgentId: message.sender?.agentId ?? undefined,
    /** The sender's user id, present only for a person's message; opens their profile panel.
     * Typed optional so a message the browser cached before it existed still reads
     * (`persisted-queries.ts`); the key itself is always written. */
    ...({ senderUserId: message.sender?.userId ?? undefined } as { senderUserId?: string }),
    /** True when the sending Agent has since been archived (deleted): the row renders its sender
     * greyed with an `ARCHIVED` marker, and opens its read-only profile. */
    senderDeleted: Boolean(message.sender?.agent?.deletedAt),
    senderAvatarUrl: browserSenderAvatarUrl(message.sender, workspaceId),
    body: message.body,
    /** A server notice's structured content, for the web to render in the viewer's language.
     * Absent for every other message and for a notice written before the backfill. */
    ...(message.systemMessage
      ? {
          system: { kind: message.systemMessage.kind, params: message.systemMessage.params },
        }
      : {}),
    /** The people that notice names, by member id, read from their member rows even when they
     * have left: the conversation's current members cannot draw them. Typed optional so a
     * message the browser cached before it existed still reads (`persisted-queries.ts`). */
    ...(message.systemMessage
      ? {
          systemPeople: noticeFacesOf(message.systemMessage.params, noticeFaces),
        }
      : ({} as { systemPeople?: Record<string, SystemPersonFace> })),
    // An ISO string, not a `Date`: TanStack Query's structural sharing keeps an unchanged
    // message's cached object across a re-read only for JSON-compatible values, and a new object
    // re-renders its memoized row.
    createdAt: message.createdAt.toISOString(),
    mentions: message.mentions.map(browserMessageMention),
    attachments: message.attachments.map((attachment) => {
      const commentCount = commentCounts?.get(attachment.id);
      return { ...attachmentView(attachment), ...(commentCount ? { commentCount } : {}) };
    }),
    reactions: reactionSummaries(message.reactions),
    /** The `reactionVersion` that `reactions` is at least as new as. Typed optional, like
     * `senderUserId`, for a message the browser cached before it existed. */
    ...({ reactionVersion: message.reactionVersion } as { reactionVersion?: number }),
    // Attached by the caller (`conversations.functions.ts`, `ActionCards.viewsFor`) in one
    // batched lookup per page; this function never queries `ActionCard` rows itself.
    actionCard: undefined as ActionCardView | undefined,
    // The snapshots of a forwarded message, with `sourceAccessible` false: each caller settles it
    // for its viewer in one batched lookup per page (`attachForwardedAccess`), never per row.
    // Absent for every other message, and typed optional so an echo that carries none still fits.
    ...((message.forwards?.length
      ? { forwarded: browserForwarded(message.forwards, message.attachments) }
      : {}) as {
      forwarded?: ForwardedMessageView[];
    }),
  };
}
