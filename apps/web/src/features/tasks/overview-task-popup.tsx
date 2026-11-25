import { usePrefetchQuery, useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import type { TaskPopupControls } from "#src/features/conversations/direct-conversation";
import { useChannelConversation } from "#src/features/conversations/use-conversation-data";
import { TaskDetailDialog } from "./task-detail-dialog";
import { TaskDetailPanel } from "./task-detail-panel";
import { useNumberedTask } from "./use-conversation-tasks";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";

type OverviewTaskPopupProps = {
  task: OverviewTaskRow;
  onOpenTask: (number: number) => void;
  onOpenTaskIn: (task: { conversationId: string; number: number }) => void;
  onClose: () => void;
  onCommand: (command: OverviewTaskCommand) => Promise<void>;
  onTaskChanged: () => void;
  inline?: TaskPopupControls["inline"];
};

export function OverviewTaskPopup(props: OverviewTaskPopupProps) {
  return (
    <ClientOnly>
      <TaskPopupBoundary {...props} />
    </ClientOnly>
  );
}

function TaskPopupBoundary(props: OverviewTaskPopupProps) {
  const { task, onClose, onCommand, inline } = props;
  const workspaceId = useCurrentWorkspaceId() ?? "";
  usePrefetchQuery(channelNamesQuery(workspaceId));
  const [conversationFailed, setConversationFailed] = useState(false);
  if (conversationFailed)
    return inline ? (
      <TaskDetailPanel
        key={task.id}
        task={task}
        mode={inline.mode}
        expanded={inline.expanded}
        onToggleExpand={inline.onToggleExpand}
        navigation={inline.navigation}
        closeOnEscape={inline.closeOnEscape}
        onClose={onClose}
        onCommand={onCommand}
        conversationName={task.source.label}
        currentMemberId={task.currentMemberId ?? null}
      />
    ) : (
      <TaskDetailDialog
        key={task.id}
        task={task}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onCommand={onCommand}
        conversationName={task.source.label}
        currentMemberId={task.currentMemberId ?? null}
      />
    );
  return (
    <CatchBoundary
      getResetKey={() => task.id}
      errorComponent={NoFallback}
      onCatch={() => setConversationFailed(true)}
    >
      <Suspense fallback={null}>
        <ChannelTaskPopup {...props} />
      </Suspense>
    </CatchBoundary>
  );
}

function NoFallback() {
  return null;
}

function ChannelTaskPopup(props: OverviewTaskPopupProps) {
  const { conversationProps } = useChannelConversation(props.task.conversationId);
  const { channels, taskPopup } = usePopupState(props);
  return <ChannelConversation {...conversationProps} channels={channels} taskPopup={taskPopup} />;
}

function usePopupState({
  task,
  onOpenTask,
  onOpenTaskIn,
  onClose,
  onTaskChanged,
  inline,
}: OverviewTaskPopupProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const taskPopup = useMemo<TaskPopupControls>(
    () => ({
      openTaskNumber: task.number,
      task,
      openTask: onOpenTask,
      openTaskIn: onOpenTaskIn,
      closeTask: onClose,
      onTaskDeleted: onTaskChanged,
      inline,
    }),
    [task, onOpenTask, onOpenTaskIn, onClose, onTaskChanged, inline],
  );
  const liveRevision = useNumberedTask(task.conversationId, task.number)?.revision;
  useEffect(() => {
    if (liveRevision !== undefined && liveRevision > task.revision) onTaskChanged();
  }, [liveRevision, task.revision, onTaskChanged]);
  return { channels, taskPopup };
}
