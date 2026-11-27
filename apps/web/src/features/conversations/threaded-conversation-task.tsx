import { useMemo, type ComponentProps, type ReactNode } from "react";

import { LazyTaskDetailDialog, LazyTaskDetailPanel } from "#src/features/tasks/lazy-task-detail";
import type { TaskDetailNavigation } from "#src/features/tasks/task-navigation-context";
import { ConversationTaskDemand } from "#src/features/tasks/conversation-task-demand";
import type { useTaskPopupProfile } from "#src/features/tasks/task-popup-profile";
import { m } from "#src/paraglide/messages";

import { ComposerScopeProvider, useComposerScope, type ComposerScope } from "./composer-scope";
import { ConversationSplit } from "./conversation-split";
import type { DirectConversationView, TaskPopupControls } from "./conversation-types";
import { ThreadPane } from "./thread-pane";

const NO_MESSAGES: DirectConversationView["messages"] = [];

type OpenTask = NonNullable<TaskPopupControls["task"]>;

export function ConversationTaskSplitPane({
  task,
  isTaskExpanded,
  onToggleExpand,
  navigation,
  onClose,
  onOpenRelated,
  conversationName,
  members,
  currentMemberId,
  thread,
  leadExtra,
  popupProfile,
}: {
  task: OpenTask;
  isTaskExpanded: boolean;
  onToggleExpand: () => void;
  navigation: TaskDetailNavigation | undefined;
  onClose: () => void;
  onOpenRelated: ComponentProps<typeof LazyTaskDetailPanel>["onOpenRelated"];
  conversationName: string;
  members: DirectConversationView["mentionables"];
  currentMemberId: string | null;
  thread: ComponentProps<typeof LazyTaskDetailPanel>["thread"];
  leadExtra: ReactNode;
  popupProfile: ReturnType<typeof useTaskPopupProfile>;
}) {
  return (
    <ConversationSplit
      layoutId="coforge-task-profile"
      reportListCrowd={false}
      main={
        <LazyTaskDetailPanel
          key={task.id}
          task={task}
          mode={isTaskExpanded ? "expanded" : "split"}
          expanded={isTaskExpanded}
          onToggleExpand={onToggleExpand}
          navigation={navigation}
          escapeEnabled={!popupProfile.open}
          onClose={onClose}
          onOpenRelated={onOpenRelated}
          conversationName={conversationName}
          members={members}
          currentMemberId={currentMemberId}
          thread={thread}
          leadExtra={leadExtra}
        />
      }
      side={popupProfile.panel}
      visibleSlot={popupProfile.open ? "profile" : undefined}
      threadAlone={false}
    />
  );
}

export function ConversationTaskLayer({
  conversation,
  channelName,
  openTask,
  openTaskNumber,
  openTaskRoot,
  taskPopup,
  taskInSplit,
  closeTaskReference,
  openRelatedTask,
  conversationName,
  taskThread,
  taskLeadExtra,
  popupProfile,
}: {
  conversation: Omit<DirectConversationView, "agent">;
  channelName: string | undefined;
  openTask: OpenTask | undefined;
  openTaskNumber: number | undefined;
  openTaskRoot: DirectConversationView["messages"][number] | undefined;
  taskPopup: TaskPopupControls | undefined;
  taskInSplit: boolean;
  closeTaskReference: () => void;
  openRelatedTask: ComponentProps<typeof LazyTaskDetailPanel>["onOpenRelated"];
  conversationName: string;
  taskThread: ComponentProps<typeof LazyTaskDetailPanel>["thread"];
  taskLeadExtra: ReactNode;
  popupProfile: ReturnType<typeof useTaskPopupProfile>;
}) {
  const taskDialog = openTask ? (
    <LazyTaskDetailDialog
      key={openTask.id}
      task={openTask}
      open
      onOpenChange={(next) => {
        if (!next) closeTaskReference();
      }}
      onDeleted={taskPopup?.onTaskDeleted}
      onOpenRelated={openRelatedTask}
      conversationName={conversationName}
      members={conversation.mentionables}
      currentMemberId={conversation.senderMemberId || null}
      thread={taskThread}
      leadExtra={taskLeadExtra}
      sidePanel={popupProfile.panel}
      onCloseSidePanel={popupProfile.close}
    />
  ) : null;

  const inlineTaskPanel =
    openTask && taskPopup?.inline ? (
      <ConversationSplit
        layoutId="coforge-task-profile"
        reportListCrowd={false}
        main={
          <LazyTaskDetailPanel
            key={openTask.id}
            task={openTask}
            mode={taskPopup.inline.mode}
            expanded={taskPopup.inline.expanded}
            onToggleExpand={taskPopup.inline.onToggleExpand}
            navigation={taskPopup.inline.navigation}
            closeOnEscape={taskPopup.inline.closeOnEscape}
            escapeEnabled={!popupProfile.open}
            onClose={closeTaskReference}
            onDeleted={taskPopup.onTaskDeleted}
            onOpenRelated={openRelatedTask}
            conversationName={conversationName}
            members={conversation.mentionables}
            currentMemberId={conversation.senderMemberId || null}
            thread={taskThread}
            leadExtra={taskLeadExtra}
          />
        }
        side={popupProfile.panel}
        visibleSlot={popupProfile.open ? "profile" : undefined}
        threadAlone={false}
      />
    ) : null;

  return (
    <>
      <ConversationTaskDemand
        conversationId={conversation.conversationId}
        channelName={channelName}
        messages={!taskPopup ? conversation.messages : openTaskRoot ? [openTaskRoot] : NO_MESSAGES}
        hasNewer={conversation.hasNewer ?? false}
        readWindow={!taskPopup}
        openTaskNumber={openTaskNumber}
      />
      {taskPopup?.inline ? inlineTaskPanel : !taskInSplit ? taskDialog : null}
    </>
  );
}

export function LegacyTaskThreadPane({
  taskNumber,
  paneProps,
  openers,
  lead,
  readOnlyNotice,
  emptyState,
}: {
  taskNumber: number;
  paneProps: Omit<
    ComponentProps<typeof ThreadPane>,
    | "inTaskPopup"
    | "lead"
    | "readOnlyNotice"
    | "emptyState"
    | "onOpenAgentProfile"
    | "onOpenPersonProfile"
  >;
  openers: ReturnType<typeof useTaskPopupProfile>["openers"];
  lead: ReactNode;
  readOnlyNotice?: ReactNode;
  emptyState: ComponentProps<typeof ThreadPane>["emptyState"];
}) {
  const parentScope = useComposerScope();
  const scope = useMemo<ComposerScope>(
    () => ({
      placeholder: m.tasks_reply_placeholder({ number: String(taskNumber) }),
      composerPortal: parentScope?.composerPortal,
    }),
    [taskNumber, parentScope?.composerPortal],
  );
  return (
    <ComposerScopeProvider value={scope}>
      <ThreadPane
        {...paneProps}
        {...openers}
        inTaskPopup
        lead={lead}
        readOnlyNotice={readOnlyNotice}
        emptyState={emptyState}
      />
    </ComposerScopeProvider>
  );
}
