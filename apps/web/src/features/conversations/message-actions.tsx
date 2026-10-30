import { useState, type ReactNode } from "react";
import { Bookmark, BookmarkCheck, Copy01, DotsHorizontal, FlipForward } from "@untitledui/icons";
import { Modal as AriaModal, ModalOverlay as AriaModalOverlay } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog } from "#src/components/application/modals/modal";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { MessageReactionPicker, QUICK_REACTION_EMOJIS } from "./message-reaction-picker";
import { ThreadSheetEntry, ThreadToolbarEntry } from "./thread-summary";
import { MessageSeenByMenuEntry, MessageSeenBySheetEntry } from "./message-seen-by";

/** What a message's actions do, bound to that message by its row. */
type MessageActions = {
  messageId: string;
  onOpenThread?: (rootId: string) => void;
  onToggleReaction?: (emoji: string) => void;
  onToggleSave?: () => void;
  saveSaved: boolean;
  /** Opens the Forward dialog; absent for a message that cannot be forwarded. */
  onForward?: () => void;
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
 * invisible bar must not swallow taps aimed at the message under it. The bar keeps the
 * frequent actions — thread, reactions, whole-message copy — and "…" holds the rarer ones
 * (forward, save, "N seen"), as Slack's bar does.
 */
export function MessageActionToolbar({
  messageId,
  grouped,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  saveSaved,
  onForward,
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
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={Copy01}
        tooltip={m.conversation_message_copy_text()}
        onClick={onCopy}
        className="p-1 *:data-icon:size-3.5"
      />
      {(onForward || onToggleSave || seenBy) && (
        <MessageMoreMenu
          messageId={messageId}
          onForward={onForward}
          onToggleSave={onToggleSave}
          saveSaved={saveSaved}
          seenBy={seenBy}
        />
      )}
    </div>
  );
}

/** The hover toolbar's "…": forward and save, then on an own message "N seen". */
function MessageMoreMenu({
  messageId,
  onForward,
  onToggleSave,
  saveSaved,
  seenBy,
}: Pick<MessageActions, "messageId" | "onForward" | "onToggleSave" | "saveSaved" | "seenBy">) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown.Root isOpen={open} onOpenChange={setOpen}>
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={DotsHorizontal}
        tooltip={m.conversation_more_actions()}
        aria-label={m.conversation_more_actions()}
        className="p-1 *:data-icon:size-3.5"
      />
      {/* As wide as its longest entry (a read time is one line), no wider. */}
      <Dropdown.Popover placement="bottom end" className="w-max min-w-40">
        <Dropdown.Menu aria-label={m.conversation_more_actions()}>
          {onForward && (
            <Dropdown.Item
              icon={FlipForward}
              label={m.message_forward_action()}
              onAction={onForward}
            />
          )}
          {onToggleSave && (
            <Dropdown.Item
              icon={saveSaved ? BookmarkCheck : Bookmark}
              label={saveSaved ? m.conversation_unsave() : m.conversation_save()}
              onAction={onToggleSave}
            />
          )}
          {(onForward || onToggleSave) && seenBy && <Dropdown.Separator />}
          {seenBy && (
            <MessageSeenByMenuEntry
              conversationId={seenBy.conversationId}
              messageId={messageId}
              menuOpen={open}
            />
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/**
 * The mobile-shell counterpart of the hover toolbar: a bottom action sheet in the
 * Slack/Discord mobile layout — the quoted message card, a quick-reaction row,
 * then full-width actions, the frequent ones (thread, whole-message copy) before the
 * rarer ones (forward, save), as the hover bar keeps them — opened by a tap
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
  onForward,
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
            {onOpenThread && (
              <ThreadSheetEntry
                rootId={messageId}
                onOpen={(rootId) => {
                  onOpenChange(false);
                  onOpenThread(rootId);
                }}
              />
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
            {(onOpenThread || copyable) && (onForward || onToggleSave) && (
              <div aria-hidden="true" className="mx-1 my-1 h-px bg-secondary" />
            )}
            {onForward && (
              <Button
                color="tertiary"
                size="md"
                noTextPadding
                iconLeading={FlipForward}
                onPress={() => {
                  onOpenChange(false);
                  onForward();
                }}
                className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
              >
                {m.message_forward_action()}
              </Button>
            )}
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
            {seenBy && (
              <>
                {(onOpenThread || copyable || onForward || onToggleSave) && (
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
