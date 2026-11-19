import { useState, type ReactNode } from "react";
import {
  Bookmark,
  BookmarkCheck,
  CheckDone01,
  CheckSquare,
  Copy01,
  DotsHorizontal,
  FlipForward,
} from "@untitledui/icons";
import { Modal as AriaModal, ModalOverlay as AriaModalOverlay } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { Dialog } from "#src/components/application/modals/modal";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { MessageReactionPicker, QUICK_REACTION_EMOJIS } from "./message-reaction-picker";
import { ThreadSheetEntry, ThreadToolbarEntry } from "./thread-summary";
import { MessageSeenByMenuEntry, MessageSeenBySheetEntry } from "./message-seen-by";

type MessageActions = {
  messageId: string;
  onOpenThread?: (rootId: string) => void;
  onToggleReaction?: (emoji: string) => void;
  onToggleSave?: () => void;
  saveSaved: boolean;
  onForward?: () => void;
  onSelect?: () => void;
  onMakeTask?: () => void;
  onCopy: () => void;
  seenBy?: { conversationId: string };
};

export function MessageActionToolbar({
  messageId,
  grouped,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  saveSaved,
  onForward,
  onSelect,
  onMakeTask,
  onCopy,
  seenBy,
}: MessageActions & { grouped: boolean }) {
  return (
    <div
      data-message-toolbar
      className={cn(
        "pointer-events-none absolute right-3 z-10 flex h-8 items-center gap-0.5 rounded-lg border border-secondary bg-primary px-0.5 opacity-0 shadow-xs transition-opacity",
        grouped ? "-top-8" : "-top-5",
        "[li:has(>[role=separator])_&]:top-0",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[aria-expanded=true]]:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[aria-expanded=true]]:opacity-100",
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
      {(onForward || onToggleSave || onMakeTask || seenBy) && (
        <MessageMoreMenu
          messageId={messageId}
          onForward={onForward}
          onSelect={onSelect}
          onMakeTask={onMakeTask}
          onToggleSave={onToggleSave}
          saveSaved={saveSaved}
          seenBy={seenBy}
        />
      )}
    </div>
  );
}

function MessageMoreMenu({
  messageId,
  onForward,
  onSelect,
  onMakeTask,
  onToggleSave,
  saveSaved,
  seenBy,
}: Pick<
  MessageActions,
  "messageId" | "onForward" | "onSelect" | "onMakeTask" | "onToggleSave" | "saveSaved" | "seenBy"
>) {
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
      <Dropdown.Popover placement="bottom end" className="w-max min-w-40">
        <Dropdown.Menu aria-label={m.conversation_more_actions()}>
          {onForward && (
            <Dropdown.Item
              icon={FlipForward}
              label={m.message_forward_action()}
              onAction={onForward}
            />
          )}
          {onSelect && (
            <Dropdown.Item
              icon={CheckDone01}
              label={m.message_select_action()}
              onAction={onSelect}
            />
          )}
          {onToggleSave && (
            <Dropdown.Item
              icon={saveSaved ? BookmarkCheck : Bookmark}
              label={saveSaved ? m.conversation_unsave() : m.conversation_save()}
              onAction={onToggleSave}
            />
          )}
          {onMakeTask && (
            <Dropdown.Item icon={CheckSquare} label={m.message_make_task()} onAction={onMakeTask} />
          )}
          {(onForward || onToggleSave || onMakeTask) && seenBy && <Dropdown.Separator />}
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
  onSelect,
  onMakeTask,
  onCopy,
  seenBy,
}: MessageActions & {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  avatar: ReactNode;
  displayName: string;
  createdAt: Date | string;
  time: string;
  plainText: string;
  copyable: boolean;
}) {
  const controlSize = useDialogControlSize();
  return (
    <AriaModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      data-message-actions-popover
      className={(state) =>
        cn(
          "fixed inset-x-0 top-0 z-50 flex h-[var(--app-height,100dvh)] items-end justify-center bg-modal-scrim/70 outline-hidden backdrop-blur-[6px]",
          state.isEntering && "motion-enter animate-in scrim-in",
          state.isExiting && "motion-leave animate-out scrim-out",
        )
      }
    >
      <AriaModal
        className={(state) =>
          cn(
            "w-full rounded-t-2xl bg-primary shadow-xl ring-1 ring-modal-edge outline-hidden",
            state.isEntering && "motion-enter-lg animate-in slide-in-from-bottom",
            state.isExiting && "motion-leave-lg animate-out slide-out-to-bottom",
          )
        }
      >
        <Dialog aria-label={m.conversation_message_actions()} className="pb-safe-bottom">
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-quaternary/40" />
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
                size={controlSize}
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
            {(onOpenThread || copyable) && (onForward || onToggleSave || onMakeTask) && (
              <div aria-hidden="true" className="mx-1 my-1 h-px bg-secondary" />
            )}
            {onForward && (
              <Button
                color="tertiary"
                size={controlSize}
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
            {onSelect && (
              <Button
                color="tertiary"
                size={controlSize}
                noTextPadding
                iconLeading={CheckDone01}
                onPress={() => {
                  onOpenChange(false);
                  onSelect();
                }}
                className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
              >
                {m.message_select_action()}
              </Button>
            )}
            {onToggleSave && (
              <Button
                color="tertiary"
                size={controlSize}
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
            {onMakeTask && (
              <Button
                color="tertiary"
                size={controlSize}
                noTextPadding
                iconLeading={CheckSquare}
                onPress={() => {
                  onOpenChange(false);
                  onMakeTask();
                }}
                className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
              >
                {m.message_make_task()}
              </Button>
            )}
            {seenBy && (
              <>
                {(onOpenThread || copyable || onForward || onToggleSave || onMakeTask) && (
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
