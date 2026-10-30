import { useCallback, useState } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { useIsMessageSaved } from "./conversation-host";
import { useOpenForward } from "./message-forward-host";
import { useMakeTaskFromMessage } from "./message-task-host";
import { canForwardMessage } from "./message-forward-model";
import type { ReadState } from "./conversation-pane-layout";
import type { MessageView } from "./message-view";
import { messagePlainText } from "./selection-copy";

/**
 * A message row's actions, bound to its message, and where they open: the hover toolbar on the
 * desktop shell, the tap action sheet on a phone (`MessageActionToolbar`, `MessageActionSheet`).
 * `hasActions` is whether the row offers any.
 */
export function useMessageRowActions({
  message,
  conversationId,
  channelNames,
  readState,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
}: {
  message: MessageView;
  conversationId?: string;
  channelNames?: ReadonlyMap<string, string>;
  readState?: ReadState;
  onOpenThread?: (rootId: string) => void;
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => void;
  onToggleSave?: (messageId: string, saved: boolean) => Promise<void>;
}) {
  const toast = useAppToast();
  const saveSaved = useIsMessageSaved(message.id);
  const openForward = useOpenForward();
  const makeTask = useMakeTaskFromMessage();
  // The mobile shell (single-pane below `lg`) has no hover to reveal the reply/reaction
  // actions, and keeping the toolbar always visible puts two buttons on every message.
  // Instead a tap on the row's non-interactive surface (an embed marked `data-no-row-tap`, such as a video's player, is not one) opens a
  // bottom action sheet holding the same actions (the wide desktop shell keeps hover/focus
  // reveal); the modal overlay
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
          "button, a, input, textarea, select, [role='button'], [data-message-actions-popover], " +
            "[data-no-row-tap]",
        )
      )
        return;
      setActionsOpen(true);
    },
    [sheetActions],
  );
  // #544's whole-message copy (the IM-standard "Copy text", the only copy path for a collapsed,
  // unselectable body) rides the action strip on desktop and the tap action sheet on the mobile
  // shell; the sheet therefore also opens for a message with no thread and no reactions.
  const copyable = Boolean(messagePlainText(message, channelNames).trim());
  // The toolbar's and the sheet's actions, bound to this message.
  const actions = {
    messageId: message.id,
    onOpenThread,
    onToggleReaction:
      onToggleReaction && ((emoji: string) => onToggleReaction(message.id, emoji, true)),
    onToggleSave:
      onToggleSave &&
      (() =>
        void onToggleSave(message.id, !saveSaved).catch(() => {
          toast.error(m.conversation_save_failed());
        })),
    saveSaved,
    onForward:
      openForward && conversationId && canForwardMessage(message)
        ? () =>
            openForward({
              message,
              conversationId,
              plainBody: messagePlainText(message, channelNames),
            })
        : undefined,
    // What can be forwarded is someone's own words, which is also what a Task can come from; a
    // Task's source is a message of the conversation itself, never a thread reply.
    onMakeTask:
      makeTask && conversationId && canForwardMessage(message) && !message.threadRootId
        ? () => makeTask({ conversationId, messageId: message.id })
        : undefined,
    seenBy: readState && conversationId ? { conversationId } : undefined,
    onCopy: () =>
      void copyText(messagePlainText(message, channelNames)).then((copied) => {
        if (copied) toast.success(m.conversation_message_copied());
        else toast.error(m.conversation_copy_failed());
      }),
  };
  const hasActions = Boolean(
    onOpenThread ||
    onToggleReaction ||
    onToggleSave ||
    actions.onForward ||
    actions.onMakeTask ||
    copyable ||
    actions.seenBy,
  );
  return { actions, copyable, hasActions, sheetActions, actionsOpen, setActionsOpen, openActions };
}
