import { useEffect, useRef, useState, type FocusEvent } from "react";
import {
  Bookmark,
  BookmarkCheck,
  CheckDone01,
  CheckSquare,
  Copy01,
  DotsHorizontal,
  FaceSmile,
  FlipForward,
  Mail01,
  MessageSquare01 as MessageSquare,
} from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { MessageReactionPicker } from "./message-reaction-picker";
import { ThreadToolbarEntry } from "./thread-summary";
import { MessageSeenByMenuEntry } from "./message-seen-by";

export { MessageActionSheet } from "./message-action-sheet";

export type MessageActions = {
  messageId: string;
  onOpenThread?: (rootId: string) => void;
  onToggleReaction?: (emoji: string) => void;
  onToggleSave?: () => void;
  saveSaved: boolean;
  onMarkThreadUnread?: () => void;
  onForward?: () => void;
  onSelect?: () => void;
  onMakeTask?: () => void;
  onCopy: () => void;
  seenBy?: { conversationId: string };
};

export type ToolbarActivation = {
  target?: "thread" | "reaction" | "copy" | "more";
  mode?: "focus" | "open";
};

export function MessageActionToolbar({
  messageId,
  grouped,
  hoverOpen = false,
  active,
  onActivate,
  onStarted,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  saveSaved,
  onMarkThreadUnread,
  onForward,
  onSelect,
  onMakeTask,
  onCopy,
  seenBy,
}: MessageActions & {
  grouped: boolean;
  hoverOpen?: boolean;
  active?: ToolbarActivation;
  onActivate: (activation: ToolbarActivation) => void;
  onStarted: () => void;
}) {
  const hasMore = Boolean(
    onForward || onSelect || onToggleSave || onMarkThreadUnread || onMakeTask || seenBy,
  );
  const focusTarget =
    (target: NonNullable<ToolbarActivation["target"]>) => (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) onActivate({ target, mode: "focus" });
    };

  return (
    <div
      data-message-toolbar
      data-toolbar-open={hoverOpen ? "true" : undefined}
      className={cn(
        "pointer-events-none absolute right-3 z-10 flex h-8 items-center rounded-lg border border-secondary bg-primary px-0.5 opacity-0 shadow-(--message-toolbar-shadow) transition-opacity duration-(--duration-label-out) ease-in after:pointer-events-auto after:absolute after:inset-x-0 after:-bottom-2 after:h-2 after:content-['']",
        grouped ? "-top-8" : "-top-5",
        "[li:has(>[role=separator])_&]:top-0",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:duration-(--duration-label-in) lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:ease-out",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:data-[toolbar-open=true]:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:data-[toolbar-open=true]:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:data-[toolbar-open=true]:duration-(--duration-label-in) lg:[@media(hover:hover)_and_(pointer:fine)]:data-[toolbar-open=true]:ease-out",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[aria-expanded=true]]:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[aria-expanded=true]]:opacity-100",
      )}
    >
      <TooltipGroup className="flex items-center gap-0.5">
        {active ? (
          <ActiveMessageActionToolbar
            messageId={messageId}
            active={active}
            onStarted={onStarted}
            onOpenThread={onOpenThread}
            onToggleReaction={onToggleReaction}
            onToggleSave={onToggleSave}
            saveSaved={saveSaved}
            onMarkThreadUnread={onMarkThreadUnread}
            onForward={onForward}
            onSelect={onSelect}
            onMakeTask={onMakeTask}
            onCopy={onCopy}
            seenBy={seenBy}
            hasMore={hasMore}
          />
        ) : (
          <>
            {onOpenThread && (
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={MessageSquare}
                aria-label={m.conversation_thread_reply()}
                onFocus={focusTarget("thread")}
                onClick={() => onOpenThread(messageId)}
                className="p-1 *:data-icon:size-3.5"
              />
            )}
            {onToggleReaction && (
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={FaceSmile}
                aria-label={m.conversation_add_reaction()}
                aria-haspopup="dialog"
                onFocus={focusTarget("reaction")}
                onClick={() => onActivate({ target: "reaction", mode: "open" })}
                className="p-1 *:data-icon:size-3.5"
              />
            )}
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Copy01}
              aria-label={m.conversation_message_copy_text()}
              onFocus={focusTarget("copy")}
              onClick={onCopy}
              className="p-1 *:data-icon:size-3.5"
            />
            {hasMore && (
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.conversation_more_actions()}
                aria-haspopup="menu"
                onFocus={focusTarget("more")}
                onClick={() => onActivate({ target: "more", mode: "open" })}
                className="p-1 *:data-icon:size-3.5"
              />
            )}
          </>
        )}
      </TooltipGroup>
    </div>
  );
}

function ActiveMessageActionToolbar({
  messageId,
  active,
  onStarted,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  saveSaved,
  onMarkThreadUnread,
  onForward,
  onSelect,
  onMakeTask,
  onCopy,
  seenBy,
  hasMore,
}: MessageActions & {
  active: ToolbarActivation;
  onStarted: () => void;
  hasMore: boolean;
}) {
  const threadRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active.target === "thread" && active.mode === "focus") {
      threadRef.current?.focus();
      onStarted();
    } else if (active.target === "copy" && active.mode === "focus") {
      copyRef.current?.focus();
      onStarted();
    }
  }, [active.target, active.mode, onStarted]);

  return (
    <>
      {onOpenThread && (
        <ThreadToolbarEntry rootId={messageId} onOpen={onOpenThread} triggerRef={threadRef} />
      )}
      {onToggleReaction && (
        <MessageReactionPicker
          onPick={(emoji) => onToggleReaction(emoji)}
          start={active.target === "reaction" ? active.mode : undefined}
          onStarted={onStarted}
        />
      )}
      <ButtonUtility
        ref={copyRef}
        size="xs"
        color="tertiary"
        icon={Copy01}
        tooltip={m.conversation_message_copy_text()}
        onClick={onCopy}
        className="p-1 *:data-icon:size-3.5"
      />
      {hasMore && (
        <MessageMoreMenu
          messageId={messageId}
          onForward={onForward}
          onSelect={onSelect}
          onMakeTask={onMakeTask}
          onToggleSave={onToggleSave}
          saveSaved={saveSaved}
          onMarkThreadUnread={onMarkThreadUnread}
          seenBy={seenBy}
          start={active.target === "more" ? active.mode : undefined}
          onStarted={onStarted}
        />
      )}
    </>
  );
}

function MessageMoreMenu({
  messageId,
  onForward,
  onSelect,
  onMakeTask,
  onToggleSave,
  saveSaved,
  onMarkThreadUnread,
  seenBy,
  start,
  onStarted,
}: Pick<
  MessageActions,
  | "messageId"
  | "onForward"
  | "onSelect"
  | "onMakeTask"
  | "onToggleSave"
  | "saveSaved"
  | "onMarkThreadUnread"
  | "seenBy"
> & {
  start?: "focus" | "open";
  onStarted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!start) return;
    triggerRef.current?.focus();
    if (start === "open") setOpen(true);
    onStarted?.();
  }, [start, onStarted]);

  return (
    <Dropdown.Root isOpen={open} onOpenChange={setOpen}>
      <ButtonUtility
        ref={triggerRef}
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
          {onMarkThreadUnread && (
            <Dropdown.Item
              icon={Mail01}
              label={m.conversation_thread_mark_unread()}
              onAction={onMarkThreadUnread}
            />
          )}
          {onMakeTask && (
            <Dropdown.Item icon={CheckSquare} label={m.message_make_task()} onAction={onMakeTask} />
          )}
          {(onForward || onSelect || onToggleSave || onMarkThreadUnread || onMakeTask) &&
            seenBy && <Dropdown.Separator />}
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
