import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { Suspense, useMemo } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { TaskPopupControls } from "#src/features/conversations/conversation-types";
import { useChannelConversation } from "#src/features/conversations/use-conversation-data";

/**
 * A Task card opened on Activity: the Task's popup over Activity, its discussion and composer as
 * a channel shows them, without the channel's chat behind it (Frank, 11-04), as the Tasks page
 * opens one over its board (`OverviewTaskPopup`). Another Task named in it opens the same way;
 * closing it goes back to the list.
 */
export function ActivityTaskPopup({
  target,
  onOpen,
  onClose,
}: {
  target: HostedConversationTarget & { task: number };
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
}) {
  return (
    <ClientOnly>
      {/* A conversation that cannot load shows no popup; the list stays. */}
      <CatchBoundary getResetKey={() => target.id} errorComponent={() => null}>
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
    }),
    [target.id, target.task, onOpen, onClose],
  );
  return <ChannelConversation {...conversationProps} channels={channels} taskPopup={taskPopup} />;
}
