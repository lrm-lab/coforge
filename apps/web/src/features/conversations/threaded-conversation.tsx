import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearch } from "@tanstack/react-router";
import { MessageSquare01 as MessageSquare } from "@untitledui/icons";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  LazyAgentProfilePanel,
  LazyPersonProfilePanel,
} from "#src/features/agents/profile-panel/lazy-profile-panels";
import { resolveVisibleConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";
import {
  TaskNavigationRegistrationContext,
  type TaskDetailNavigation,
} from "#src/features/tasks/task-navigation-context";
import { useOpenRelatedTask } from "#src/features/tasks/use-open-related-task";
import { useNumberedTask } from "#src/features/tasks/use-conversation-tasks";
import { ownsDiscussion } from "#src/features/tasks/task-follow";
import { useTaskPopupProfile } from "#src/features/tasks/task-popup-profile";

import { ConversationPane } from "./conversation-pane";
import { SeenByDirectory } from "./message-seen-by";
import { useConversationDetailVisible } from "./conversation-navigation";
import { useConversationSync, useTaskPopupRoot } from "./use-conversation-sync";
import { useStandaloneThread } from "./standalone-thread";
import {
  useConversationPositionJump,
  useOpenConversationTask,
  useOpenConversationThread,
} from "./open-conversation-thread";
import { ThreadPane } from "./thread-pane";
import { TaskDiscussionPane } from "./task-discussion-pane";
import { TaskEarlierDiscussion } from "./task-earlier-discussion";
import { NO_THREADS, NO_UNREAD_MARKS } from "./thread-summary-model";
import { useThreadTailSequence } from "./thread-queries";
import { ThreadRootState, type ThreadRootLoad } from "./thread-root-state";
import { useConversationFocus } from "./conversation-focus";
import { ConversationSplit } from "./conversation-split";
import { ConversationIdProvider } from "./conversation-id";
import { ThreadStoreProvider, useConversationThreadStore } from "./thread-store";
import { resolveConversationThreadRoot } from "./conversation-thread-search";
import type { DirectConversationView, ThreadedConversationProps } from "./conversation-types";
import { useConversationChannels } from "./use-conversation-channels";
import {
  ConversationTaskLayer,
  ConversationTaskSplitPane,
  LegacyTaskThreadPane,
} from "./threaded-conversation-task";

export function ThreadedConversation(props: ThreadedConversationProps) {
  return (
    <ConversationIdProvider conversationId={props.conversation.conversationId}>
      <SeenByDirectory members={props.conversation.mentionables}>
        <ThreadedConversationContent {...props} />
      </SeenByDirectory>
    </ConversationIdProvider>
  );
}

function ThreadedConversationContent(props: ThreadedConversationProps) {
  const {
    conversation,
    onReadThread,
    onMarkThreadUnread,
    header,
    pinnedStrip,
    threadHeaderAction,
    threadFollow,
    threadContext,
    agentProfile,
    onAgentProfileTabChange,
    onCloseAgentProfile,
    onLoadMessageAround,
    onReadLatest,
    conversationName,
    tasksPane,
    detailsOpen,
    detailsPane,
    channels,
    taskPopup,
    jumpMessage,
    onJumpMessageConsumed,
    ...conversationProps
  } = props;
  const desktop = useBreakpoint("lg");
  const detailVisible = useConversationDetailVisible();
  const standaloneThread = useStandaloneThread();
  const { searchThreadRootId, openThread, openThreadFromHash, closeThread, showThreadRoot } =
    useOpenConversationThread();
  const { jumpMessageId, clearJumpMessage } = useConversationPositionJump();
  const threadRoots = useRef(new Map<string, DirectConversationView["messages"][number]>());
  const { channelList, channelNames, formatPreviewBody } = useConversationChannels(
    channels,
    conversation.mentionables,
  );
  const focus = useConversationFocus();
  const conversationTaskPopup = useOpenConversationTask();
  const {
    openTaskNumber,
    openTask: rawOpenTaskReference,
    closeTask: closeTaskReference,
  } = taskPopup ?? conversationTaskPopup;
  const openTaskReference = useCallback(
    (number: number) => {
      if (desktop && !taskPopup && focus?.focused === "chat") focus.toggle("chat");
      rawOpenTaskReference(number);
    },
    [desktop, taskPopup, focus, rawOpenTaskReference],
  );
  const openTask = useNumberedTask(conversation.conversationId, openTaskNumber) ?? taskPopup?.task;
  const openRelatedTask = useOpenRelatedTask({
    channels: channelList,
    openHere: openTaskReference,
    openIn: taskPopup?.openTaskIn,
  });
  const [taskExpanded, setTaskExpanded] = useState(false);
  const [registeredTaskNav, setRegisteredTaskNav] = useState<TaskDetailNavigation | undefined>(
    undefined,
  );
  const isTaskExpanded = Boolean(openTask) && taskExpanded;
  const taskDiscussionId = openTask?.discussionConversationId ?? undefined;
  const ownDiscussion = Boolean(openTask && ownsDiscussion(openTask));
  const [earlierOf, setEarlierOf] = useState<string>();
  const earlier = ownDiscussion ? openTask?.earlierDiscussion : undefined;
  const earlierOpen = Boolean(earlier && earlierOf === openTask?.id);
  const openTaskMessageId =
    ownDiscussion && !earlierOpen ? undefined : (openTask?.messageId ?? undefined);
  const { root: openTaskRoot, reads: taskRootReads } = useTaskPopupRoot(
    conversation,
    openTaskMessageId,
  );
  const profileAgentId = agentProfile?.agentId;
  const profilePersonId = agentProfile?.personId;
  const profileOpen = Boolean(profileAgentId || profilePersonId);
  const standaloneRootId = standaloneThread && !profileOpen ? standaloneThread.rootId : undefined;
  const selected = resolveConversationThreadRoot({
    searchThreadRootId: searchThreadRootId ?? standaloneRootId,
    messages: conversation.messages,
  });

  const docOpen = useSearch({
    strict: false,
    select: (search) => typeof search.doc === "string",
  });
  const taskInSplit = !taskPopup && desktop && Boolean(openTask);
  const visibleSlot = resolveVisibleConversationSlot({
    threadOpen: Boolean(selected),
    profileOpen,
    detailsOpen: Boolean(detailsOpen && detailsPane),
    taskOpen: taskInSplit,
    docOpen: docOpen && standaloneThread === null,
  });
  const threadPaneVisible = (rootId: string) => visibleSlot === "thread" && selected === rootId;
  const threadInView =
    openTaskRoot?.id ??
    (detailVisible && focus?.focused !== "chat" && visibleSlot === "thread" ? selected : undefined);
  const threadRootOf = (rootId: string) =>
    conversation.messages.find((message) => message.id === rootId) ??
    threadRoots.current.get(rootId);
  const threadInViewSequence = useThreadTailSequence(conversation.conversationId, threadInView);
  const threadInViewRootSequence =
    openTaskRoot?.sequence ?? (threadInView ? threadRootOf(threadInView)?.sequence : undefined);
  const { visited, windowRead, threadRootFailure, loadThreadRoot } = useConversationSync({
    conversation,
    searchThreadRootId,
    openTaskMessageId,
    taskRootReads,
    selected,
    threadInView,
    threadInViewSequence,
    threadInViewRootSequence,
    onLoadMessageAround,
    onReadThread,
    openThreadFromHash,
    closeThread,
  });
  const sidePaneProps = {
    ...conversationProps,
    onOpenTask: openTaskReference,
    channelNames,
    channels: channelList,
    onLoadMessageAround,
    onFollowingLatestChange: undefined,
  };
  const threadPaneProps = (root: DirectConversationView["messages"][number]) => ({
    ...sidePaneProps,
    streamRead: windowRead,
    root,
    conversation,
    onSend: (
      ...[body, idempotencyKey, attachmentIds, options]: Parameters<typeof conversationProps.onSend>
    ) =>
      conversationProps.onSend(body, idempotencyKey, attachmentIds, {
        ...options,
        threadRootId: root.id,
      }),
  });
  const taskRepliesEmpty = {
    title: m.tasks_no_replies(),
    description: "",
    media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
  };
  const popupProfile = useTaskPopupProfile(openTask?.id);
  const taskLeadExtra =
    openTask && earlier ? (
      <TaskEarlierDiscussion
        replyCount={earlier.replyCount}
        open={earlierOpen}
        onOpenChange={(open) => setEarlierOf(open ? openTask.id : undefined)}
      />
    ) : undefined;
  const taskThread =
    openTask && (ownDiscussion || openTaskMessageId !== undefined)
      ? (lead: ReactNode) => {
          if (ownDiscussion && !earlierOpen)
            return (
              <TaskDiscussionPane
                {...sidePaneProps}
                jumpMessage={taskPopup?.landingMessageId}
                {...popupProfile.openers}
                lead={lead}
                conversationId={taskDiscussionId}
                board={{ conversationId: conversation.conversationId, number: openTask.number }}
                changedAt={openTask.updatedAt}
                mentionables={conversation.mentionables}
                emptyState={taskRepliesEmpty}
              />
            );
          return (
            openTaskRoot && (
              <LegacyTaskThreadPane
                taskNumber={openTask.number}
                paneProps={threadPaneProps(openTaskRoot)}
                openers={popupProfile.openers}
                lead={lead}
                readOnlyNotice={ownDiscussion ? <></> : undefined}
                emptyState={taskRepliesEmpty}
              />
            )
          );
        }
      : undefined;

  const taskLayer = (
    <ConversationTaskLayer
      conversation={conversation}
      channelName={channelNames.get(conversation.conversationId)}
      openTask={openTask}
      openTaskNumber={openTaskNumber}
      openTaskRoot={openTaskRoot}
      taskPopup={taskPopup}
      taskInSplit={taskInSplit}
      closeTaskReference={closeTaskReference}
      openRelatedTask={openRelatedTask}
      conversationName={conversationName}
      taskThread={taskThread}
      taskLeadExtra={taskLeadExtra}
      popupProfile={popupProfile}
    />
  );

  const selectedThreadKnown = selected !== undefined && threadRootOf(selected) !== undefined;
  const attemptedRootLoad = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) {
      attemptedRootLoad.current = undefined;
      return;
    }
    if (selectedThreadKnown || attemptedRootLoad.current === selected) return;
    attemptedRootLoad.current = selected;
    void loadThreadRoot(selected);
  }, [selected, selectedThreadKnown, loadThreadRoot]);
  const selectedRootLoad: ThreadRootLoad | undefined =
    selected && !selectedThreadKnown
      ? threadRootFailure?.rootId === selected
        ? threadRootFailure.load
        : { status: "loading" }
      : undefined;
  const threadState = useMemo(
    () => ({
      conversationId: conversation.conversationId,
      summaries: conversation.threads ?? NO_THREADS,
      unreadMarks: conversation.threadUnreadMarks ?? NO_UNREAD_MARKS,
      formatBody: formatPreviewBody,
    }),
    [
      conversation.conversationId,
      conversation.threads,
      conversation.threadUnreadMarks,
      formatPreviewBody,
    ],
  );
  const threads = useConversationThreadStore(threadState);
  useEffect(() => {
    const roots = threadRoots.current;
    for (const rootId of roots.keys()) if (!visited.includes(rootId)) roots.delete(rootId);
    for (const rootId of visited) {
      const root = conversation.messages.find((message) => message.id === rootId);
      if (root) roots.set(rootId, root);
    }
  }, [visited, conversation.messages]);
  const threadAlone = standaloneThread !== null;
  const threadClose = standaloneThread?.onClose ?? closeThread;
  const viewInConversation = standaloneThread?.onViewInConversation ?? showThreadRoot;
  const markThreadUnread =
    onMarkThreadUnread && conversation.senderMemberId
      ? async (rootId: string) => {
          await onMarkThreadUnread(rootId);
          if (selected === rootId) threadClose();
        }
      : undefined;
  if (taskPopup) return taskLayer;
  const conversationMainPane = (
    <ThreadStoreProvider store={threads}>
      <ConversationPane
        {...conversationProps}
        streamRead={windowRead}
        onOpenTask={openTaskReference}
        channelNames={channelNames}
        channels={channelList}
        jumpMessage={jumpMessage ?? jumpMessageId}
        onJumpMessageConsumed={jumpMessage ? onJumpMessageConsumed : clearJumpMessage}
        paneVisible={detailVisible}
        onLoadMessageAround={onLoadMessageAround}
        onReadLatest={onReadLatest}
        header={header}
        pinnedStrip={pinnedStrip}
        conversation={conversation}
        composerTarget={threadContext}
        onOpenThread={openThread}
        onMarkThreadUnread={markThreadUnread}
      />
    </ThreadStoreProvider>
  );
  const conversationSidePane = visibleSlot && (
    <>
      {visibleSlot === "details" && detailsPane}
      {visibleSlot === "task" && openTask && (
        <ConversationTaskSplitPane
          task={openTask}
          isTaskExpanded={isTaskExpanded}
          onToggleExpand={() => setTaskExpanded((current) => !current)}
          navigation={registeredTaskNav}
          onClose={() => {
            setTaskExpanded(false);
            closeTaskReference();
          }}
          onOpenRelated={openRelatedTask}
          conversationName={conversationName}
          members={conversation.mentionables}
          currentMemberId={conversation.senderMemberId || null}
          thread={taskThread}
          leadExtra={taskLeadExtra}
          popupProfile={popupProfile}
        />
      )}
      {visibleSlot === "profile" && profileAgentId && (
        <LazyAgentProfilePanel
          agentId={profileAgentId}
          visible={focus?.focused !== "chat"}
          requestedTab={agentProfile?.tab}
          onTabChange={(tab) => onAgentProfileTabChange?.(tab)}
          onClose={() => onCloseAgentProfile?.()}
        />
      )}
      {visibleSlot === "profile" && !profileAgentId && profilePersonId && (
        <LazyPersonProfilePanel
          key={profilePersonId}
          userId={profilePersonId}
          onClose={() => onCloseAgentProfile?.()}
        />
      )}
      {visited.map((rootId) => {
        const root = threadRootOf(rootId);
        if (!root) return null;
        return (
          <section
            key={rootId}
            aria-label={m.conversation_thread()}
            hidden={!threadPaneVisible(rootId)}
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              threadPaneVisible(rootId) ? "flex" : "hidden",
            )}
          >
            <ThreadPane
              {...threadPaneProps(root)}
              paneVisible={detailVisible && threadPaneVisible(rootId)}
              onClose={threadClose}
              threadContext={threadContext}
              onViewInConversation={() => viewInConversation(rootId)}
              onMarkThreadUnread={markThreadUnread}
              threadFollow={threadFollow?.(rootId)}
              emptyState={{
                title: m.conversation_thread_empty_title(),
                description: m.conversation_thread_empty(),
                media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
              }}
              threadHeaderAction={threadHeaderAction?.(rootId)}
            />
          </section>
        );
      })}
      {selected && selectedRootLoad && (
        <section
          aria-label={m.conversation_thread()}
          hidden={!threadPaneVisible(selected)}
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col",
            threadPaneVisible(selected) ? "flex" : "hidden",
          )}
        >
          <ThreadRootState
            load={selectedRootLoad}
            context={threadContext}
            onClose={threadClose}
            onRetry={() => void loadThreadRoot(selected)}
          />
        </section>
      )}
    </>
  );
  return (
    <TaskNavigationRegistrationContext.Provider value={setRegisteredTaskNav}>
      <ConversationSplit
        main={tasksPane ?? conversationMainPane}
        side={conversationSidePane}
        visibleSlot={visibleSlot}
        threadAlone={threadAlone}
        focused={focus?.focused}
        sideExpanded={visibleSlot === "task" && isTaskExpanded}
      />
      {taskLayer}
    </TaskNavigationRegistrationContext.Provider>
  );
}
