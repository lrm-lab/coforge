import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";
import { Suspense, useMemo, useState } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { TaskPopupControls } from "#src/features/conversations/conversation-types";
import { useChannelConversation } from "#src/features/conversations/use-conversation-data";
import { m } from "#src/paraglide/messages";

export function ActivityTaskPopup({
  target,
  onOpen,
  onClose,
}: {
  target: HostedConversationTarget & { task: number };
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
}) {
  const [retryCount, setRetryCount] = useState(0);
  return (
    <ClientOnly>
      <CatchBoundary
        getResetKey={() => `${target.id}:${target.task}:${retryCount}`}
        errorComponent={({ reset }) => (
          <ModalOverlay isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
            <Modal className="w-full max-w-md">
              <Dialog aria-label={m.empty_activity_task_load_failed_title()} className="p-4">
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
              </Dialog>
            </Modal>
          </ModalOverlay>
        )}
      >
        <Suspense fallback={null}>
          <ActivityTaskConversation target={target} onOpen={onOpen} onClose={onClose} />
        </Suspense>
      </CatchBoundary>
    </ClientOnly>
  );
}

function ActivityTaskConversation({
  target,
  onOpen,
  onClose,
}: {
  target: HostedConversationTarget & { task: number };
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
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
    }),
    [target.id, target.task, target.messageId, onOpen, onClose],
  );
  return <ChannelConversation {...conversationProps} channels={channels} taskPopup={taskPopup} />;
}
