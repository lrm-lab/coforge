import type { ReactNode } from "react";
import { Bookmark, BookmarkCheck, Copy01 } from "@untitledui/icons";
import { Modal as AriaModal, ModalOverlay as AriaModalOverlay } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog } from "#src/components/application/modals/modal";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { MessageReactionPicker, QUICK_REACTION_EMOJIS } from "./message-reaction-picker";
import { ThreadSheetEntry, ThreadToolbarEntry } from "./thread-summary";
import { MessageSeenByMenu, MessageSeenBySheetEntry } from "./message-seen-by";

/** What a message's actions do, bound to that message by its row. */
type MessageActions = {
  messageId: string;
  onOpenThread?: (rootId: string) => void;
  onToggleReaction?: (emoji: string) => void;
  onToggleSave?: () => void;
  saveSaved: boolean;
  onCopy: () => void;
  /** An own message's "N seen" (`message-seen-by.tsx`), read from its conversation. */
  seenBy?: { conversationId: string };
};

/**
 * A message's action toolbar. Hidden until revealed: hover/focus in the wide desktop shell (`lg` and up, with
 * a hover-capable fine pointer). The thread icon carries no unread dot: the
 * preview line already shows the count (task #267). Everywhere else the row tap opens
 * the action sheet instead. The reveal needs all three conditions: below `lg` the
 * mobile shell is in charge even on a mouse-driven narrow window; mobile browsers
 * stick `:hover` onto a tapped row (it has a click handler); and some touch devices
 * (iOS Safari) report `hover: hover` anyway — any missing gate would leave the bar
 * visible after the sheet closes. Hidden also means `pointer-events-none` — an
 * invisible bar must not swallow taps aimed at the message under it. Order is thread,
 * reactions, then whole-message copy last — the IM-standard order (#546).
 */
export function MessageActionToolbar({
  messageId,
  grouped,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  saveSaved,
  onCopy,
  seenBy,
}: MessageActions & { grouped: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute right-3 flex items-center gap-0.5 opacity-0 transition-opacity",
        // 12px from the top of a heading row (design spec); a continuation has no top padding.
        grouped ? "top-0.5" : "top-3",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100",
      )}
    >
      {onOpenThread && <ThreadToolbarEntry rootId={messageId} onOpen={onOpenThread} />}
      {onToggleReaction && <MessageReactionPicker onPick={(emoji) => onToggleReaction(emoji)} />}
      {onToggleSave && (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={saveSaved ? BookmarkCheck : Bookmark}
          tooltip={saveSaved ? m.conversation_unsave() : m.conversation_save()}
          aria-label={saveSaved ? m.conversation_unsave() : m.conversation_save()}
          onClick={onToggleSave}
          className="p-1 *:data-icon:size-3.5"
        />
      )}
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={Copy01}
        tooltip={m.conversation_message_copy_text()}
        onClick={onCopy}
        className="p-1 *:data-icon:size-3.5"
      />
      {seenBy && <MessageSeenByMenu conversationId={seenBy.conversationId} messageId={messageId} />}
    </div>
  );
}

/**
 * The mobile-shell counterpart of the hover toolbar: a bottom action sheet in the
 * Slack/Discord mobile layout — the quoted message card, a quick-reaction row,
 * then full-width actions (thread row, whole-message copy last) — opened by a tap
 * on the message. Dismissal (backdrop press, Escape) and focus containment come
 * from the modal overlay. The overlay carries `data-message-actions-popover` so
 * its backdrop press doesn't bubble back into the row's tap-to-open handler.
 */
export function MessageActionSheet({
  isOpen,
  onOpenChange,
  messageId,
  avatar,
  displayName,
  createdAt,
  time,
  plainText,
  copyable,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  saveSaved,
  onCopy,
  seenBy,
}: MessageActions & {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tapped message as the sheet quotes it at its top. */
  avatar: ReactNode;
  displayName: string;
  createdAt: Date | string;
  time: string;
  plainText: string;
  copyable: boolean;
}) {
  return (
    <AriaModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
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
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-quaternary/40" />
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
                  dateTime={new Date(createdAt).toISOString()}
                  className="shrink-0 text-xs text-tertiary tabular-nums"
                >
                  {time}
                </time>
              </p>
              <p className="line-clamp-2 text-sm text-secondary [overflow-wrap:anywhere]">
                {plainText}
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
                    onOpenChange(false);
                    onToggleReaction(emoji);
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
                  onOpenChange(false);
                  onToggleSave();
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
                rootId={messageId}
                onOpen={(rootId) => {
                  onOpenChange(false);
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
                  onOpenChange(false);
                  onCopy();
                }}
                className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
              >
                {m.conversation_message_copy_text()}
              </Button>
            )}
            {seenBy && (
              <>
                {(onToggleReaction || onToggleSave || onOpenThread || copyable) && (
                  <div aria-hidden="true" className="mx-1 my-1 h-px bg-secondary" />
                )}
                <MessageSeenBySheetEntry
                  conversationId={seenBy.conversationId}
                  messageId={messageId}
                />
              </>
            )}
          </div>
        </Dialog>
      </AriaModal>
    </AriaModalOverlay>
  );
}
