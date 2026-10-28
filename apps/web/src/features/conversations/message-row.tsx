import { memo, useCallback, useState } from "react";
import {
  WeeklyReportMessageCard,
  type WeeklyReportMessageSuggestion,
} from "#src/features/records/weekly-report-message-card";
import { Bookmark, BookmarkCheck, Copy01 } from "@untitledui/icons";
import { Modal as AriaModal, ModalOverlay as AriaModalOverlay } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { useAppToast } from "#src/components/ui/toast";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog } from "#src/components/application/modals/modal";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { LiveAgentAvatar } from "#src/features/agents/live-agent-avatar";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ActionCard } from "./action-card";
import { MessageSenderLine } from "./message-sender-line";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";
import { attachmentMessageDisplayBody } from "./attachment-file-name";
import { useIsMessageSaved } from "./conversation-host";
import { CollapsibleMessageBody } from "./collapsible-message-body";
import type { ChipMention } from "./message-markdown";
import { MessageReactionPicker, QUICK_REACTION_EMOJIS } from "./message-reaction-picker";
import { ThreadSheetEntry, ThreadToolbarEntry } from "./thread-summary";
import type { ReactionSummary } from "./message-reactions";
import { messagePlainText } from "./selection-copy";
import { QuoteSelectionBar, useQuoteSelection } from "./message-quote-selection";
import { copyText } from "#src/lib/clipboard";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { clockLabel } from "#src/lib/dates";
import { gutterClockLabel } from "./gutter-clock-label";
import { DayDivider, UnreadDivider, dayLabel } from "./message-dividers";
import { SystemMessageRow } from "./system-message-row";
import { GROUPING_WINDOW_MS } from "./conversation-pane-layout";
import { MessageRowFooter } from "./message-row-footer";
import { AgentReadReceipt } from "./message-status-markers";
import { MessageSenderGutter } from "./message-sender-gutter";

// The conversation pane reads the day with the rows it groups.
export { dayLabel };

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
  weeklyReportSuggestion?: WeeklyReportMessageSuggestion;
  weeklyReportDisplayBody?: string;
  /** Platform wake stored for the Agent. The conversation pane omits the row. */
  weeklyReportHidden?: boolean;
};

export { GROUPING_WINDOW_MS } from "./conversation-pane-layout";

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
  agentRead = false,
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
  agentRead?: boolean;
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
  const toast = useAppToast();
  const saveSaved = useIsMessageSaved(message.id);
  // Reply-to-selection (`message-quote-selection.tsx`): the body's gestures read the highlight,
  // and the bar offers quoting or copying it.
  const quoteSelection = useQuoteSelection({
    onQuoteSelection,
    author: displayName,
    time: clockLabel(message.createdAt, dateLocale, timeFormat, timeZone),
  });
  // The mobile shell (single-pane below `lg`) has no hover to reveal the reply/reaction
  // actions, and keeping the toolbar always visible puts two buttons on every message.
  // Instead a tap on the row's non-interactive surface opens a bottom action sheet holding
  // the same actions (the wide desktop shell keeps hover/focus reveal); the modal overlay
  // owns dismissal (backdrop press, Escape). The switch follows the shell, not only the
  // pointer: a narrow desktop window shows the mobile shell, so it gets sheet interactions
  // too, and a large touchscreen still prefers tapping. The tap target check runs against
  // the DOM, so it also covers portaled overlays, whose React events still bubble through
  // this row.
  const coarsePointer = useCoarsePointer();
  const desktopShell = useBreakpoint("lg");
  const sheetActions = coarsePointer || !desktopShell;
  const [actionsOpen, setActionsOpen] = useState(false);
  const openActions = useCallback(
    (event: React.MouseEvent) => {
      if (!sheetActions || !(event.target instanceof Element)) return;
      if (
        event.target.closest(
          "button, a, input, textarea, select, [role='button'], [data-message-actions-popover]",
        )
      )
        return;
      setActionsOpen(true);
    },
    [sheetActions],
  );
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
  // #544's whole-message copy (the IM-standard "Copy text", the only copy path for a collapsed,
  // unselectable body) rides the action strip on desktop and the tap action sheet on the mobile
  // shell; the sheet therefore also opens for a message with no thread and no reactions.
  const copyable = Boolean(messagePlainText(message, channelNames).trim());
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
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
          ) : (
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
                // A grouped row has no sender header, so the hover action strip would sit on its
                // first text line; reserve the strip's width (thread + reaction + save + copy)
                // there. Only where that strip can appear — the same gate as the strip below: a
                // touch screen opens the action sheet instead, and the reserve was 80px of blank
                // on every continuation line on a phone.
                grouped && "lg:[@media(hover:hover)_and_(pointer:fine)]:pr-20",
              )}
            >
              <CollapsibleMessageBody
                body={attachmentMessageDisplayBody(message)}
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
          )}
          <MessageRowFooter
            message={message}
            viewerId={viewerId}
            onToggleReaction={
              onToggleReaction && ((emoji, active) => onToggleReaction(message.id, emoji, active))
            }
            showsTask={showsTask}
            onOpenThread={onOpenThread}
          />
          {agentRead && <AgentReadReceipt />}
        </div>
        {(onOpenThread || onToggleReaction || onToggleSave || copyable) && (
          /* Hidden until revealed: hover/focus in the wide desktop shell (`lg` and up, with
             a hover-capable fine pointer). The thread icon carries no unread dot: the
             preview line already shows the count (task #267). Everywhere else the row tap opens
             the action sheet instead. The reveal needs all three conditions: below `lg` the
             mobile shell is in charge even on a mouse-driven narrow window; mobile browsers
             stick `:hover` onto a tapped row (it has a click handler); and some touch devices
             (iOS Safari) report `hover: hover` anyway — any missing gate would leave the bar
             visible after the sheet closes. Hidden also means `pointer-events-none` — an
             invisible bar must not swallow taps aimed at the message under it. Order is thread,
             reactions, then whole-message copy last — the IM-standard order (#546). */
          <div
            className={cn(
              "pointer-events-none absolute right-3 flex items-center gap-0.5 opacity-0 transition-opacity",
              // 12px from the top of a heading row (design spec); a continuation has no top padding.
              grouped ? "top-0.5" : "top-3",
              "lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100",
              "lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100",
            )}
          >
            {onOpenThread && <ThreadToolbarEntry rootId={message.id} onOpen={onOpenThread} />}
            {onToggleReaction && (
              <MessageReactionPicker
                onPick={(emoji) => onToggleReaction(message.id, emoji, true)}
              />
            )}
            {onToggleSave && (
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={saveSaved ? BookmarkCheck : Bookmark}
                tooltip={saveSaved ? m.conversation_unsave() : m.conversation_save()}
                aria-label={saveSaved ? m.conversation_unsave() : m.conversation_save()}
                onClick={() => {
                  void onToggleSave(message.id, !saveSaved).catch(() => {
                    toast.error(m.conversation_save_failed());
                  });
                }}
                className="p-1 *:data-icon:size-3.5"
              />
            )}
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Copy01}
              tooltip={m.conversation_message_copy_text()}
              onClick={() => {
                void copyText(messagePlainText(message, channelNames)).then((copied) => {
                  if (copied) toast.success(m.conversation_message_copied());
                  else toast.error(m.conversation_copy_failed());
                });
              }}
              className="p-1 *:data-icon:size-3.5"
            />
          </div>
        )}
        {sheetActions && (onOpenThread || onToggleReaction || onToggleSave || copyable) && (
          /* The mobile-shell counterpart of the hover toolbar: a bottom action sheet in the
             Slack/Discord mobile layout — the quoted message card, a quick-reaction row,
             then full-width actions (thread row, whole-message copy last) — opened by a tap
             on the message. Dismissal (backdrop press, Escape) and focus containment come
             from the modal overlay. The overlay carries `data-message-actions-popover` so
             its backdrop press doesn't bubble back into the row's tap-to-open handler. */
          <AriaModalOverlay
            isOpen={actionsOpen}
            onOpenChange={setActionsOpen}
            isDismissable
            data-message-actions-popover
            className={(state) =>
              cn(
                "fixed inset-0 z-50 flex min-h-dvh items-end justify-center bg-overlay/70 outline-hidden backdrop-blur-[6px]",
                state.isEntering && "duration-300 ease-out animate-in fade-in",
                state.isExiting && "duration-200 ease-in animate-out fade-out",
              )
            }
          >
            <AriaModal
              className={(state) =>
                cn(
                  "w-full rounded-t-2xl bg-primary shadow-xl outline-hidden",
                  state.isEntering && "duration-300 ease-out animate-in slide-in-from-bottom",
                  state.isExiting && "duration-200 ease-in animate-out slide-out-to-bottom",
                )
              }
            >
              <Dialog
                aria-label={m.conversation_message_actions()}
                className="pb-[env(safe-area-inset-bottom)]"
              >
                <div
                  aria-hidden="true"
                  className="mx-auto mt-2 h-1 w-9 rounded-full bg-quaternary/40"
                />
                {/* The tapped message, quoted in a muted card at the top — the Slack/Discord
                    mobile signature that tells you which message the actions belong to. */}
                <div className="mx-3 mt-3 flex gap-2.5 rounded-xl bg-secondary/60 p-3">
                  <span className="shrink-0">{avatar}</span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-primary">
                        {displayName}
                      </span>
                      <time
                        dateTime={new Date(message.createdAt).toISOString()}
                        className="shrink-0 text-xs text-tertiary tabular-nums"
                      >
                        {clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
                      </time>
                    </p>
                    <p className="line-clamp-2 text-sm text-secondary [overflow-wrap:anywhere]">
                      {messagePlainText(message, channelNames)}
                    </p>
                  </div>
                </div>
                {onToggleReaction && (
                  <div
                    role="group"
                    aria-label={m.conversation_add_reaction()}
                    className="flex items-center px-3 pt-2 pb-1"
                  >
                    {QUICK_REACTION_EMOJIS.map((emoji) => (
                      <Button
                        key={emoji}
                        color="tertiary"
                        size="sm"
                        noTextPadding
                        onPress={() => {
                          setActionsOpen(false);
                          onToggleReaction(message.id, emoji, true);
                        }}
                        // `px-0!` overrides the size's horizontal padding so the quick
                        // emojis share the row's width evenly instead of overflowing it.
                        className="h-auto min-w-0 flex-1 rounded-full px-0! py-3 text-display-xs leading-none"
                      >
                        {emoji}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="flex flex-col px-3 pt-1 pb-3">
                  {onToggleSave && (
                    <Button
                      color="tertiary"
                      size="md"
                      noTextPadding
                      iconLeading={saveSaved ? BookmarkCheck : Bookmark}
                      onPress={() => {
                        setActionsOpen(false);
                        void onToggleSave(message.id, !saveSaved).catch(() => {
                          toast.error(m.conversation_save_failed());
                        });
                      }}
                      className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
                    >
                      {saveSaved ? m.conversation_unsave() : m.conversation_save()}
                    </Button>
                  )}
                  {(onToggleReaction || onToggleSave) && (copyable || onOpenThread) && (
                    <div aria-hidden="true" className="mx-1 mt-1 mb-1 h-px bg-secondary" />
                  )}
                  {onOpenThread && (
                    <ThreadSheetEntry
                      rootId={message.id}
                      onOpen={(rootId) => {
                        setActionsOpen(false);
                        onOpenThread(rootId);
                      }}
                    />
                  )}
                  {copyable && onOpenThread && (
                    <div aria-hidden="true" className="mx-1 my-1 h-px bg-secondary" />
                  )}
                  {copyable && (
                    <Button
                      color="tertiary"
                      size="md"
                      noTextPadding
                      iconLeading={Copy01}
                      onPress={() => {
                        setActionsOpen(false);
                        void copyText(messagePlainText(message, channelNames)).then((copied) => {
                          if (copied) toast.success(m.conversation_message_copied());
                          else toast.error(m.conversation_copy_failed());
                        });
                      }}
                      className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
                    >
                      {m.conversation_message_copy_text()}
                    </Button>
                  )}
                </div>
              </Dialog>
            </AriaModal>
          </AriaModalOverlay>
        )}
      </div>
    </li>
  );
});
