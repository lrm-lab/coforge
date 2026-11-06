import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { Suspense, useMemo } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import type { TaskPopupControls } from "#src/features/conversations/conversation-types";
import { DirectConversation } from "#src/features/conversations/direct-conversation";
import { PeopleDirectConversation } from "#src/features/conversations/people-direct-conversation";
import {
  useChannelConversation,
  useDirectConversation,
} from "#src/features/conversations/use-conversation-data";
import { useOpenOtherTask, type OtherTask } from "./other-task-search";

/**
 * A Task of another conversation, opened over whatever page is showing (a label in a message, a
 * related Task): the same popup its conversation shows, its discussion and composer included,
 * without leaving the page (Frank, 11-06). A conversation that cannot load shows no popup and
 * leaves nothing in the address.
 */
export function OtherTaskPopup({ task }: { task: OtherTask }) {
  const { close } = useOpenOtherTask();
  return (
    <ClientOnly>
      <CatchBoundary
        getResetKey={() => task.conversationId}
        errorComponent={() => null}
        onCatch={close}
      >
        <Suspense fallback={null}>
          {task.kind === "channel" ? (
            <ChannelTaskPopup key={task.conversationId} task={task} />
          ) : (
            <DirectTaskPopup key={task.conversationId} task={task} />
          )}
        </Suspense>
      </CatchBoundary>
    </ClientOnly>
  );
}

function usePopupControls(task: OtherTask) {
  const { open, close } = useOpenOtherTask();
  return useMemo<TaskPopupControls>(
    () => ({
      openTaskNumber: task.number,
      openTask: (number) => open({ ...task, number }),
      openTaskIn: ({ conversationId, number }) => open({ kind: "channel", conversationId, number }),
      closeTask: close,
      onTaskDeleted: close,
    }),
    [task, open, close],
  );
}

function ChannelTaskPopup({ task }: { task: OtherTask }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const { conversationProps } = useChannelConversation(task.conversationId);
  const taskPopup = usePopupControls(task);
  return <ChannelConversation {...conversationProps} channels={channels} taskPopup={taskPopup} />;
}

function DirectTaskPopup({ task }: { task: OtherTask }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const { conversation, conversationProps, page } = useDirectConversation(task.conversationId);
  const taskPopup = usePopupControls(task);
  return conversation.kind === "agent" ? (
    <DirectConversation
      {...conversationProps}
      conversation={conversation}
      channels={channels}
      taskPopup={taskPopup}
      onChanged={page.invalidate}
    />
  ) : (
    <PeopleDirectConversation
      {...conversationProps}
      conversation={conversation}
      channels={channels}
      taskPopup={taskPopup}
      onChanged={page.invalidate}
    />
  );
}
