import { memo } from "react";
import { WeeklyReportMessageCard } from "#src/features/records/weekly-report-message-card";

import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { LiveAgentAvatar } from "#src/features/agents/live-agent-avatar";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ActionCard } from "./action-card";
import { MessageSenderLine } from "./message-sender-line";
import { attachmentMessageDisplayBody } from "./attachment-file-name";
import { CollapsibleMessageBody } from "./collapsible-message-body";
import type { ChipMention } from "./message-markdown";
import { messagePlainText } from "./selection-copy";
import { QuoteSelectionBar, useQuoteSelection } from "./message-quote-selection";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { clockLabel } from "#src/lib/dates";
import { gutterClockLabel } from "./gutter-clock-label";
import { DayDivider, UnreadDivider, dayLabel } from "./message-dividers";
import { SystemMessageRow } from "./system-message-row";
import { MessageRowFooter } from "./message-row-footer";
import { OwnMessageTicks } from "./message-status-markers";
import { MessageSenderGutter } from "./message-sender-gutter";
import { MessageActionSheet, MessageActionToolbar } from "./message-actions";
import { useMessageRowActions } from "./message-row-actions";
import { ForwardedMessageCard } from "./message-forward-card";
import { ReviewLanding } from "./attachment-review-address";
import type { MessageView } from "./message-view";
import type { ReadState } from "./conversation-pane-layout";

/** A grouped row has no sender header, so the hover action strip would sit on its first line: the
 * strip's width (thread, reaction, forward, save, copy) is reserved there, only where the strip can
 * appear (a touch screen opens the action sheet instead). */
const HOVER_BAR_RESERVE_CLASS = "lg:[@media(hover:hover)_and_(pointer:fine)]:pr-24";

// The conversation pane reads the day with the rows it groups.
export { dayLabel };
export { groupsWithPrevious } from "./message-view";

/** A row is a plain flow item: its height is whatever its content needs, and nothing — neither
 * this file nor the conversation around it — estimates that height in advance.
 *
 * Off-screen skipping (`content-visibility: auto` with `contain-intrinsic-size: auto 160px`) was
 * tried here and removed: it gives every never-rendered row a 160px placeholder, and prepending
 * older history at the top of the pane then forces a batch of those placeholders to resolve to
 * their real heights inside the viewport. The resulting shift re-triggers scroll anchoring, which
 * changes which rows count as near the viewport, which lays out more of them — a feedback loop
 * that pins the main thread until the renderer is killed. */
export const ROW_CLASS = "flex flex-col";

/**
 * One history row: optional day divider, then the message with its hover actions.
 *
 * Memoized: a conversation re-renders on every send, poll, page and pane change, and a row only
 * needs to when its own message or row state does. Callers keep its props stable (`useCallback`,
 * `useLatestCallback` for event handlers) so an unrelated change skips the row.
 */
export const MessageRow = memo(function MessageRow({
  message,
  conversationId,
  showsTask = false,
  own,
  dayChanged,
  grouped,
  expanded,
  onToggleExpanded,
  collapsible = true,
  unreadStartsHere,
  highlighted,
  dateLocale,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  onOpenAgentProfile,
  onOpenPersonProfile,
  viewerId,
  plainMentions,
  onOpenTask,
  channelNames,
  onQuoteSelection,
  readState,
}: {
  message: MessageView;
  conversationId?: string;
  own: boolean;
  dayChanged: boolean;
  grouped: boolean;
  /** Whether this message's very long body is showing in full. Owned by the conversation rather
   * than the row, so a row that re-renders (or is skipped and rendered again as you scroll) never
   * collapses behind the reader. */
  expanded: boolean;
  /** Called with this row's message id, so one stable handler serves every row. */
  onToggleExpanded: (messageId: string) => void;
  /** Whether a long body may fold at all (the viewer's "Collapse long messages" preference). */
  collapsible?: boolean;
  /** The conversation's unread run begins at this row: draws the divider above. */
  unreadStartsHere?: boolean;
  /** A position jump just landed on this row, so it wears the anchor highlight for a moment. The
   * `#message-<id>` deep link gets that from `:target` below; a saved jump carries no hash
   * (#713) and the pane highlights the row by id instead — same classes, either way. */
  highlighted?: boolean;
  dateLocale?: string;
  /** Opens a root's thread. Present, the row offers its thread (the toolbar and sheet entries,
   * and the preview card), each reading its own root's thread summary (`thread-summary.tsx`). */
  onOpenThread?: (rootId: string) => void;
  /** Shows the Task the message became under it (`MessageTask`): the conversation's own stream
   * does, a thread pane (whose root the Task popup already shows) does not. */
  showsTask?: boolean;
  /** Toggles the viewer's own emoji reaction on a message; the conversation refreshes it. */
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => void;
  /** Saves/unsaves this message for the viewer (#127): the conversation owns the write, the
   * Chat page's Saved context supplies `saved`. Absent, the row offers no save action. */
  onToggleSave?: (messageId: string, saved: boolean) => Promise<void>;
  /** Opens the Agent profile panel, on a given tab when one is named; present only where the
   * conversation owns that slot (`features/agents/profile-panel/`'s `openAgentProfile`). Absent, the
   * avatar/name render inert and the avatar has no hover card. */
  onOpenAgentProfile?: OpenAgentProfile;
  /** Opens a person's profile panel from a person sender's avatar or name; absent, they render
   * inert. Your own messages open yours too. */
  onOpenPersonProfile?: OpenPersonProfile;
  /** The viewing user's id; a mention of them renders with the stronger "me" chip, and a reaction
   * with them among its reactors is theirs. */
  viewerId?: string;
  /** The conversation's member directory as handle → chip, so a plain `@handle` in the body
   * (DM text, or a channel body written without the completion) still renders the member's
   * display label. Absent, plain handles render as literal text. */
  plainMentions?: Map<string, ChipMention>;
  /** Opens a task reference's detail popup (see `MessageBody`). */
  onOpenTask?: (number: number) => void;
  /** Channel id → current name, for the channel links in the body (see `MessageBody`). */
  channelNames?: ReadonlyMap<string, string>;
  /** Offers "reply to this selection" on a highlight inside this row's body: the row hands back
   * the finished markdown quote, credited to the message it came from. Absent (e.g. the
   * conversation has no composer to put it in), no affordance is offered and no selection is
   * read at all. */
  onQuoteSelection?: (quote: string) => void;
  readState?: ReadState;
}) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const displayName = own ? m.conversation_you() : message.senderName;
  const deleted = Boolean(message.senderDeleted);
  const openableAgentId =
    !own && message.senderKind === "agent" && message.senderAgentId && onOpenAgentProfile
      ? message.senderAgentId
      : undefined;
  const openablePersonId =
    message.senderKind === "user" && message.senderUserId && onOpenPersonProfile
      ? message.senderUserId
      : undefined;
  // The sender's profile, an Agent's or a person's, when the conversation offers it.
  const openSenderProfile = openableAgentId
    ? () => onOpenAgentProfile?.(openableAgentId)
    : openablePersonId
      ? () => onOpenPersonProfile?.(openablePersonId)
      : undefined;
  // A deleted sender is visually muted: a grey avatar tone and an `ARCHIVED` badge beside the name.
  // Its profile still opens, read-only.
  // An Agent's avatar in the stream carries the same online/working/thinking/error/offline dot the
  // sidebar, conversation header and @-mention popup use, so you can tell whether the Agent that
  // wrote a message is around right now without opening its profile. It reads that one Agent from
  // the live store. The mascot stays a still sticker in the stream (`mascots.md`). A person's
  // avatar stays plain here (presence is on the Members page); a deleted Agent shows no dot — not
  // a presence state.
  const avatar =
    message.senderKind === "agent" && message.senderAgentId ? (
      <LiveAgentAvatar
        agentId={message.senderAgentId}
        name={message.senderName}
        src={message.senderAvatarUrl}
        deleted={deleted}
      />
    ) : (
      <IdentityAvatar
        size="sm"
        name={message.senderName}
        src={message.senderAvatarUrl}
        deleted={deleted}
      />
    );
  // Reply-to-selection (`message-quote-selection.tsx`): the body's gestures read the highlight,
  // and the bar offers quoting or copying it.
  const quoteSelection = useQuoteSelection({
    onQuoteSelection,
    author: displayName,
    time: clockLabel(message.createdAt, dateLocale, timeFormat, timeZone),
  });
  const { actions, copyable, hasActions, sheetActions, actionsOpen, setActionsOpen, openActions } =
    useMessageRowActions({
      message,
      conversationId,
      channelNames,
      readState,
      onOpenThread,
      onToggleReaction,
      onToggleSave,
    });
  // A system notice renders as one muted line, not a person talking (`SystemMessageRow`).
  if (message.senderKind === "system")
    return (
      <SystemMessageRow
        message={message}
        unreadStartsHere={unreadStartsHere}
        dayChanged={dayChanged}
        highlighted={highlighted}
        dateLocale={dateLocale}
      />
    );
  const displayBody = attachmentMessageDisplayBody(message);
  // A forward's own text is its note; an empty one leaves only the card.
  const showsBody = !message.forwarded || displayBody.trim() !== "";
  // An own message's ticks follow its last word; one with no text keeps them at its bottom right.
  const textTicks =
    readState && !message.actionCard && displayBody.trim() ? (
      <OwnMessageTicks readState={readState} inline />
    ) : undefined;
  return (
    // Spacing (design spec, docs/design/page-skeleton-and-density.md): a message with a sender
    // heading keeps 12px between its content and its hover background on all four sides; a
    // same-sender continuation keeps 12px at the sides only and sits 4px under the row above. Two
    // sender runs are 32px apart content to content from `md` up (16px of margin after a
    // continuation's 4px, 8px after a heading row's 12px) and 24px on a phone (8px and 0), where
    // 32px read as a blank band between short messages (task #118). The row is inset 4px (24px column: 12px) so the content
    // stays on the stream's column with the composer and the dividers.
    <li
      data-message-id={message.id}
      data-header-row={grouped ? undefined : ""}
      className={cn(
        ROW_CLASS,
        !grouped &&
          !dayChanged &&
          !unreadStartsHere &&
          "mt-2 first:mt-0 md:mt-4 [[data-header-row]+&]:mt-0 md:[[data-header-row]+&]:mt-2",
        // A continuation under a thread preview card starts 16px below the card (design spec):
        // a heading row ends 12px under its card, a continuation row 4px.
        grouped &&
          "[[data-header-row]:has([data-thread-preview])+&]:mt-1 [li:not([data-header-row]):has([data-thread-preview])+&]:mt-3",
      )}
    >
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={message.createdAt} locale={dateLocale} />}
      <div
        id={`message-${message.id}`}
        data-message={own ? "own" : "other"}
        onClick={openActions}
        className={cn(
          "group/message relative mx-1 flex scroll-m-6 rounded-lg px-3 transition-[background-color,box-shadow] duration-500 hover:bg-message-hover focus-within:bg-message-hover target:bg-tertiary target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-primary md:mx-3",
          highlighted && "bg-tertiary ring-2 ring-brand/50 ring-offset-4 ring-offset-primary",
          "gap-3",
          grouped ? "pt-0 pb-1" : "py-3",
        )}
      >
        <MessageSenderGutter
          message={message}
          grouped={grouped}
          conversationId={conversationId}
          openableAgentId={openableAgentId}
          openablePersonId={openablePersonId}
          onOpenAgentProfile={onOpenAgentProfile}
          openSenderProfile={openSenderProfile}
          avatar={avatar}
          gutterTime={gutterClockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
          fullTime={clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
        />
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5 has-[[data-read-ticks=latest]]:pr-5 lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[data-read-ticks=hover]]:pr-5">
          {!grouped && (
            <MessageSenderLine
              message={message}
              displayName={displayName}
              deleted={deleted}
              onOpenSender={openSenderProfile}
              time={clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
            />
          )}
          {message.actionCard ? (
            <>
              {/* The raw summary (and draft hint) stay accessible; the card renders them. */}
              <span className="sr-only">{message.body}</span>
              <ActionCard card={message.actionCard} />
            </>
          ) : showsBody ? (
            // `relative` anchors the reply-to-selection affordance to the body it was highlighted
            // out of; the gesture handlers live here rather than on the row so dragging from a
            // message's text (its timestamp, say) cannot raise an offer for it. It is also the text
            // the scroll anchor holds in place across a load (`data-scroll-anchor`).
            <div
              ref={quoteSelection.bodyRef}
              data-scroll-anchor
              onMouseUp={quoteSelection.read}
              onKeyUp={quoteSelection.read}
              className={cn(
                "relative min-w-0 text-md text-primary [overflow-wrap:anywhere]",
                // See `HOVER_BAR_RESERVE_CLASS`: a touch screen opens the action sheet instead,
                // and the reserve was 80px of blank on every continuation line on a phone.
                grouped && HOVER_BAR_RESERVE_CLASS,
              )}
            >
              <CollapsibleMessageBody
                body={displayBody}
                trailing={textTicks}
                mentions={message.mentions}
                plainMentions={plainMentions}
                viewerId={viewerId}
                onOpenTask={onOpenTask}
                channelNames={channelNames}
                onOpenAgentProfile={onOpenAgentProfile}
                onOpenPersonProfile={onOpenPersonProfile}
                expanded={expanded}
                collapsible={collapsible}
                onToggleExpanded={() => onToggleExpanded(message.id)}
              />
              {message.weeklyReportSuggestion ? (
                <WeeklyReportMessageCard
                  messageId={message.id}
                  suggestion={message.weeklyReportSuggestion}
                  onOpenAgentProfile={onOpenAgentProfile}
                  disabled={deleted}
                />
              ) : null}
              {onQuoteSelection && (
                <QuoteSelectionBar selection={quoteSelection} onQuote={onQuoteSelection} />
              )}
            </div>
          ) : null}
          {/* A file's review opened from this message lands here when its address is opened again;
              a reply's thread is in the address already. */}
          <ReviewLanding value={message.threadRootId ? undefined : message.id}>
            {message.forwarded && (
              // The attachments are the card's; the footer below draws none for a forward. A
              // continuation with no note has no text line to reserve the hover bar's width.
              <div className={cn(grouped && !showsBody && HOVER_BAR_RESERVE_CLASS)}>
                <ForwardedMessageCard
                  forwarded={message.forwarded}
                  attachments={message.attachments}
                />
              </div>
            )}
            <MessageRowFooter
              message={message.forwarded ? { ...message, attachments: [] } : message}
              viewerId={viewerId}
              onToggleReaction={
                onToggleReaction && ((emoji, active) => onToggleReaction(message.id, emoji, active))
              }
              showsTask={showsTask}
              onOpenThread={onOpenThread}
              cornerTicks={textTicks ? undefined : readState}
            />
          </ReviewLanding>
        </div>
        {hasActions && <MessageActionToolbar {...actions} grouped={grouped} />}
        {sheetActions && hasActions && (
          <MessageActionSheet
            {...actions}
            isOpen={actionsOpen}
            onOpenChange={setActionsOpen}
            avatar={avatar}
            displayName={displayName}
            createdAt={message.createdAt}
            time={clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
            plainText={messagePlainText(message, channelNames)}
            copyable={copyable}
          />
        )}
      </div>
    </li>
  );
});
