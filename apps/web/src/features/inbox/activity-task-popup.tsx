import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { useHotkeys, type HotkeyChord } from "@tanstack/react-hotkeys";
import { AlertCircle } from "@untitledui/icons";
import { type KeyboardEvent, Suspense, useMemo, useRef, useState } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { ComposerHostContext } from "#src/features/conversations/composer-host";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { TaskPopupControls } from "#src/features/conversations/conversation-types";
import { useChannelConversation } from "#src/features/conversations/use-conversation-data";
import {
  useIsRecordingShortcut,
  useShortcutBindings,
} from "#src/features/shortcuts/shortcut-bindings";
import type { TaskDetailNavigation } from "#src/features/tasks/task-detail-panel";
import { m } from "#src/paraglide/messages";
import type { ActivityPaneFlow } from "./activity-conversation-pane";
import { ActivityFlowHint, ActivityFlowHintContext } from "./activity-flow-hint";

export function ActivityTaskPopup({
  target,
  onOpen,
  onClose,
  inline = false,
  expanded = false,
  onToggleExpand,
  navigation,
  flow,
}: {
  target: HostedConversationTarget & { task: number };
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
  inline?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  navigation?: TaskDetailNavigation;
  flow?: ActivityPaneFlow;
}) {
  const [retryCount, setRetryCount] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const nextKeys = useShortcutBindings("activityNext");
  const prevKeys = useShortcutBindings("activityPrev");
  const doneKeys = useShortcutBindings("activityDone");
  const recording = useIsRecordingShortcut();
  const onListKey = (event: globalThis.KeyboardEvent) => flow?.onListKey(event);
  useHotkeys(
    [...nextKeys, ...prevKeys, ...doneKeys].map((hotkey) => ({
      hotkey: hotkey as HotkeyChord,
      callback: onListKey,
    })),
    { target: pane, enabled: inline && flow !== undefined && !recording, ignoreInputs: true },
  );
  const composerRef = flow?.composerRef;
  const composerHost = useMemo(
    () =>
      inline && composerRef
        ? {
            autoFocus: false,
            overhead: <ActivityFlowHint />,
            composerRef,
            showAgentActivity: false,
            forTask: true,
          }
        : { autoFocus: false, showAgentActivity: false, forTask: true },
    [inline, composerRef],
  );
  const done = flow?.done ?? false;
  const hint = useMemo(
    () => (inline && composerRef ? { done, composerRef } : null),
    [inline, done, composerRef],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!inline || !flow) return;
    if (event.key === "Escape") {
      const composing = event.nativeEvent.isComposing || event.keyCode === 229;
      const own = event.target === flow.composerRef.current;
      if (!event.defaultPrevented && !composing && own) flow.onBackToList();
      return;
    }
    flow.onKeyDown(event);
  };

  const content = (
    <ClientOnly>
      <CatchBoundary
        getResetKey={() => `${target.id}:${target.task}:${retryCount}`}
        errorComponent={({ reset }) => {
          const empty = (
            <EmptyState
              role="alert"
              picture={<EmptyIcon icon={AlertCircle} />}
              title={m.empty_activity_task_load_failed_title()}
              description={m.empty_load_failed_safe()}
              primaryAction={
                <RetryButton
                  onPress={() => {
                    setRetryCount((n) => n + 1);
                    reset();
                  }}
                />
              }
              secondaryAction={
                <Button size="sm" color="tertiary" onPress={onClose}>
                  {m.controls_close()}
                </Button>
              }
            />
          );
          if (inline) {
            return (
              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-primary p-4">
                {empty}
              </div>
            );
          }
          return (
            <ModalOverlay isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
              <Modal className="w-full max-w-md">
                <Dialog aria-label={m.empty_activity_task_load_failed_title()} className="p-4">
                  {empty}
                </Dialog>
              </Modal>
            </ModalOverlay>
          );
        }}
      >
        <Suspense fallback={null}>
          <ActivityTaskConversation
            target={target}
            onOpen={onOpen}
            onClose={onClose}
            inline={
              inline
                ? {
                    mode: expanded ? "expanded" : "split",
                    expanded,
                    onToggleExpand,
                    navigation,
                    closeOnEscape: flow === undefined,
                  }
                : undefined
            }
          />
        </Suspense>
      </CatchBoundary>
    </ClientOnly>
  );

  if (!inline) return content;

  return (
    <div
      ref={pane}
      onKeyDown={onKeyDown}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-s border-secondary bg-primary"
    >
      <ActivityFlowHintContext value={hint}>
        <ComposerHostContext value={composerHost}>{content}</ComposerHostContext>
      </ActivityFlowHintContext>
    </div>
  );
}

function ActivityTaskConversation({
  target,
  onOpen,
  onClose,
  inline,
}: {
  target: HostedConversationTarget & { task: number };
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
  inline?: TaskPopupControls["inline"];
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const { conversationProps } = useChannelConversation(target.id);
  const taskPopup = useMemo<TaskPopupControls>(
    () => ({
      openTaskNumber: target.task,
      openTask: (number) =>
        onOpen({ kind: "channel", id: target.id, task: number, taskAlone: true }),
      openTaskIn: ({ conversationId, number }) =>
        onOpen({ kind: "channel", id: conversationId, task: number, taskAlone: true }),
      closeTask: onClose,
      onTaskDeleted: onClose,
      landingMessageId: target.messageId,
      inline,
    }),
    [target.id, target.task, target.messageId, onOpen, onClose, inline],
  );
  return <ChannelConversation {...conversationProps} channels={channels} taskPopup={taskPopup} />;
}
