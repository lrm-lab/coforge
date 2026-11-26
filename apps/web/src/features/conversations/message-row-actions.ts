import { useCallback, useState } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { useIsMessageSaved } from "./conversation-host";
import { useOpenForward } from "./message-forward-host";
import { useMessageSelection } from "./message-selection";
import { useMakeTaskFromMessage } from "./message-task-host";
import { useIsHostTaskMessage } from "#src/features/tasks/use-conversation-tasks";
import { canForwardMessage } from "./message-forward-model";
import type { ReadState } from "./conversation-pane-layout";
import type { MessageView } from "./message-view";
import { messagePlainText } from "./selection-copy";

export function useMessageRowActions({
  message,
  conversationId,
  channelNames,
  readState,
  seenBy,
  onOpenThread,
  onMarkThreadUnread,
  onToggleReaction,
  onToggleSave,
  inStream = false,
}: {
  message: MessageView;
  inStream?: boolean;
  conversationId?: string;
  channelNames?: ReadonlyMap<string, string>;
  readState?: ReadState;
  seenBy?: boolean;
  onOpenThread?: (rootId: string) => void;
  onMarkThreadUnread?: (rootId: string) => void;
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => void;
  onToggleSave?: (messageId: string, saved: boolean) => Promise<void>;
}) {
  const toast = useAppToast();
  const saveSaved = useIsMessageSaved(message.id);
  const openForward = useOpenForward();
  const selection = useMessageSelection();
  const makeTask = useMakeTaskFromMessage();
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
  const copyable = Boolean(message.body.trim());
  const canMarkThread = Boolean(onMarkThreadUnread && !message.threadRootId);
  const isHostTask = useIsHostTaskMessage(conversationId, message.id, canMarkThread);
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
    onMarkThreadUnread:
      canMarkThread && !isHostTask ? () => onMarkThreadUnread?.(message.id) : undefined,
    onForward:
      openForward && conversationId && canForwardMessage(message)
        ? () =>
            openForward({
              messages: [{ message, plainBody: messagePlainText(message, channelNames) }],
              conversationId,
            })
        : undefined,
    onSelect:
      selection && inStream && conversationId && canForwardMessage(message)
        ? () =>
            selection.toggle(conversationId, {
              message,
              plainBody: messagePlainText(message, channelNames),
            })
        : undefined,
    onMakeTask:
      makeTask && conversationId && canForwardMessage(message) && !message.threadRootId
        ? () => makeTask({ conversationId, messageId: message.id })
        : undefined,
    seenBy: (readState || seenBy) && conversationId ? { conversationId } : undefined,
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
    actions.onMarkThreadUnread ||
    actions.onForward ||
    actions.onMakeTask ||
    copyable ||
    actions.seenBy,
  );
  return { actions, copyable, hasActions, sheetActions, actionsOpen, setActionsOpen, openActions };
}
