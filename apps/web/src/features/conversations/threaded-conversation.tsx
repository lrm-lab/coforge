import { useEffect, useMemo, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { MessageSquare01 as MessageSquare } from "@untitledui/icons";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { PersonProfilePanel } from "#src/features/agents/person-profile-panel";
import { resolveVisibleConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";
import { TaskDetailDialog } from "#src/features/tasks/task-detail-dialog";
import { ConversationTaskDemand } from "#src/features/tasks/conversation-task-demand";
import { useNumberedTask } from "#src/features/tasks/use-conversation-tasks";
import { ownsDiscussion } from "#src/features/tasks/task-follow";

import { ConversationPane } from "./conversation-pane";
import { SeenByDirectory } from "./message-seen-by";
import { useConversationDetailVisible } from "./conversation-navigation";
import { useConversationHostChannels } from "./conversation-host";
import { useConversationSync, useTaskPopupRoot } from "./use-conversation-sync";
import { useStandaloneThread } from "./standalone-thread";
import {
  useConversationPositionJump,
  useOpenConversationTask,
  useOpenConversationThread,
} from "./open-conversation-thread";
import { makeReferenceBodyFormatter } from "./mention-text";
import { ThreadPane } from "./thread-pane";
import { TaskDiscussionPane } from "./task-discussion-pane";
import { NO_THREADS } from "./thread-summary-model";
import { useThreadTailSequence } from "./thread-queries";
import { ThreadRootState, type ThreadRootLoad } from "./thread-root-state";
import { localLayoutStorage } from "./local-layout-storage";
import { ConversationIdProvider } from "./conversation-id";
import { ThreadStoreProvider, useConversationThreadStore } from "./thread-store";
import { resolveConversationThreadRoot } from "./conversation-thread-search";
import type { DirectConversationView, ThreadedConversationProps } from "./conversation-types";
import type { ChannelSuggestion } from "./reference-completion";

/** No channels to link or suggest: one array, so what is memoized on the list keeps. */
const NO_CHANNELS: readonly ChannelSuggestion[] = [];
/** No messages whose Tasks to read. */
const NO_MESSAGES: DirectConversationView["messages"] = [];

/**
 * A conversation is rendered in the browser only, and this does not check it: Chat's routes are
 * `ssr: false`, and the hosted pane and the Tasks page's Task popup (`OverviewTaskPopup`) mount it
 * under `ClientOnly`. Its collections fail if it is ever reached on the server.
 */
export function ThreadedConversation(props: ThreadedConversationProps) {
  return (
    <ConversationIdProvider conversationId={props.conversation.conversationId}>
      <ThreadedConversationContent {...props} />
    </ConversationIdProvider>
  );
}

function ThreadedConversationContent(props: ThreadedConversationProps) {
  const {
    conversation,
    onReadThread,
    header,
    threadHeaderAction,
    threadFollow,
    threadContext,
    agentProfile,
    onAgentProfileTabChange,
    onCloseAgentProfile,
    onLoadMessageAround,
    // Held out of `conversationProps` so the thread panes (which spread it) never receive it:
    // only the main pane may advance the conversation-level read cursor.
    onReadLatest,
    conversationName,
    tasksPane,
    channels,
    taskPopup,
    jumpMessage,
    onJumpMessageConsumed,
    ...conversationProps
  } = props;
  const detailVisible = useConversationDetailVisible();
  const standaloneThread = useStandaloneThread();
  const { searchThreadRootId, openThread, openThreadFromHash, closeThread, showThreadRoot } =
    useOpenConversationThread();
  // The Saved view's `?message=` position jump reads its search state here, next to the
  // thread's — the wrapper owns the router so `ConversationPane` below stays hook-free.
  const { jumpMessageId, clearJumpMessage } = useConversationPositionJump();
  // The stream's open waits for the window that holds the message it lands on (task #358).
  const landingConversation = useMemo(
    () => ({ ...conversation, landing: jumpMessage ?? jumpMessageId }),
    [conversation, jumpMessage, jumpMessageId],
  );
  // An open thread keeps its last-seen root. The bounded window drops a root's page when the main
  // stream is scrolled far enough; the thread pane then keeps showing the thread's root as it was
  // (its replies are the thread's own Query, which the window does not bound) rather than going
  // blank or reloading the stream around the root.
  const threadRoots = useRef(new Map<string, DirectConversationView["messages"][number]>());
  // A stored channel reference links to its channel, under its current name, only when the
  // Workspace has that channel: every channel by id, closed ones included, from the hosting page.
  const hostChannels = useConversationHostChannels();
  const channelList = channels ?? hostChannels ?? NO_CHANNELS;
  const channelNames = useMemo(
    () => new Map(channelList.map((channel) => [channel.id, channel.name])),
    [channelList],
  );
  // Preview rows would otherwise spell a reference as its raw `<@kind:…>` token; resolve those
  // the way the message list does.
  const formatPreviewBody = useMemo(
    () => makeReferenceBodyFormatter(conversation.mentionables ?? [], channelNames),
    [conversation.mentionables, channelNames],
  );
  const conversationTaskPopup = useOpenConversationTask();
  const {
    openTaskNumber,
    openTask: openTaskReference,
    closeTask: closeTaskReference,
  } = taskPopup ?? conversationTaskPopup;
  const openTask = useNumberedTask(conversation.conversationId, openTaskNumber) ?? taskPopup?.task;
  // A Task with a conversation of its own, or made without a message (one nobody has spoken about
  // yet), shows that conversation, never a message's thread.
  const taskDiscussionId = openTask?.discussionConversationId ?? undefined;
  const ownDiscussion = Boolean(openTask && ownsDiscussion(openTask));
  const openTaskMessageId = ownDiscussion ? undefined : (openTask?.messageId ?? undefined);
  const { root: openTaskRoot, reads: taskRootReads } = useTaskPopupRoot(
    conversation,
    openTaskMessageId,
  );
  // What every thread pane shares: the side pane and the thread under the task popup.
  const sidePaneProps = {
    ...conversationProps,
    onOpenTask: openTaskReference,
    channelNames,
    channels: channelList,
    onLoadMessageAround,
    // A side pane has its own scroll position; it must never steer the main stream's refetch policy.
    onFollowingLatestChange: undefined,
  };
  const threadPaneProps = (root: DirectConversationView["messages"][number]) => ({
    ...sidePaneProps,
    streamRead: windowRead,
    root,
    conversation: { ...conversation, readThroughSequence: threadCursor(root.id) },
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
  const dialog = openTask ? (
    <TaskDetailDialog
      // One popup instance per task: switching tasks from a chip inside the popup starts fresh.
      key={openTask.id}
      task={openTask}
      open
      onOpenChange={(next) => {
        if (!next) closeTaskReference();
      }}
      onDeleted={taskPopup?.onTaskDeleted}
      conversationName={conversationName}
      members={conversation.mentionables}
      currentMemberId={conversation.senderMemberId || null}
      onOpenSource={taskPopup ? undefined : conversationTaskPopup.showMessage}
      thread={
        ownDiscussion
          ? (taskSection) => (
              <TaskDiscussionPane
                {...sidePaneProps}
                conversationId={taskDiscussionId}
                board={{ conversationId: conversation.conversationId, number: openTask.number }}
                mentionables={conversation.mentionables}
                rootSlot={taskSection}
                emptyState={taskRepliesEmpty}
              />
            )
          : openTaskRoot &&
            ((taskSection) => (
              <ThreadPane
                {...threadPaneProps(openTaskRoot)}
                rootSlot={taskSection}
                emptyState={taskRepliesEmpty}
              />
            ))
      }
    />
  ) : null;
  // The Tasks the stream and the popup show are read here, once per window rather than per row. A
  // popup shown alone has no stream: only its thread's references are read.
  const taskLayer = (
    <>
      <ConversationTaskDemand
        conversationId={conversation.conversationId}
        messages={!taskPopup ? conversation.messages : openTaskRoot ? [openTaskRoot] : NO_MESSAGES}
        hasNewer={conversation.hasNewer ?? false}
        readWindow={!taskPopup}
        openTaskNumber={openTaskNumber}
      />
      {dialog}
    </>
  );
  const profileAgentId = agentProfile?.agentId;
  const profilePersonId = agentProfile?.personId;
  const profileOpen = Boolean(profileAgentId || profilePersonId);
  // A thread shown alone (Activity) is the host's, open whatever `threadRootId` says: a profile
  // opened from it covers it, and closing the profile returns to it.
  const standaloneRootId = standaloneThread && !profileOpen ? standaloneThread.rootId : undefined;
  const selected = resolveConversationThreadRoot({
    searchThreadRootId: searchThreadRootId ?? standaloneRootId,
    messages: conversation.messages,
  });

  // The conversation's shared right-hand slot: Thread (`threadRootId` search) and the Agent
  // profile panel (`profile` search) are mutually exclusive. Their open hooks clear the other
  // search param; the resolver remains defensive for legacy URLs containing both.
  const visibleSlot = resolveVisibleConversationSlot({
    threadOpen: Boolean(selected),
    profileOpen,
  });
  const threadPaneVisible = (rootId: string) => visibleSlot === "thread" && selected === rootId;
  // The thread/profile pane's share of the width is the user's to set; remembered across visits,
  // and kept separate per slot (`react-resizable-panels` derives its storage key from `panelIds`,
  // so ["main","thread"] and ["main","profile"] never share or corrupt each other's saved size).
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });
  // Panels are flex items sized by the library's inline styles, so a narrow viewport cannot
  // collapse the split with CSS; unmount the resizable Group and stack full-width panes
  // instead. Both panes stay mounted so drafts and scroll survive, matching the desktop slot.
  const wideViewport = useBreakpoint("md");
  // The thread in view is marked read: the task popup's when it is open, else the side pane's.
  const threadInView = openTaskRoot?.id ?? (detailVisible ? selected : undefined);
  const threadInViewSequence = useThreadTailSequence(conversation.conversationId, threadInView);
  const { visited, windowRead, threadCursor, threadRootFailure, loadThreadRoot } =
    useConversationSync({
      conversation,
      searchThreadRootId,
      openTaskMessageId,
      taskRootReads,
      selected,
      threadInView,
      threadInViewSequence,
      onLoadMessageAround,
      onReadThread,
      openThreadFromHash,
      closeThread,
    });
  /** A thread's root: as loaded, else as last seen while it was open. */
  const threadRootOf = (rootId: string) =>
    conversation.messages.find((message) => message.id === rootId) ??
    threadRoots.current.get(rootId);
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
  // The selected thread's first message has not been seen: the window around the root is read, as
  // for any fresh open, and the thread slot says so while it is, and why if the read failed —
  // instead of opening an empty pane. Only a read's failure is kept: a read that succeeded centres
  // the window on the root, so until the root shows up it is loading.
  const selectedRootLoad: ThreadRootLoad | undefined =
    selected && !selectedThreadKnown
      ? threadRootFailure?.rootId === selected
        ? threadRootFailure.load
        : { status: "loading" }
      : undefined;
  // What the stream's thread summaries read, each by its own root (`thread-summary.tsx`).
  const threadState = useMemo(
    () => ({
      conversationId: conversation.conversationId,
      summaries: conversation.threads ?? NO_THREADS,
      formatBody: formatPreviewBody,
    }),
    [conversation.conversationId, conversation.threads, formatPreviewBody],
  );
  const threads = useConversationThreadStore(threadState);
  // Records each open thread's root while it is loaded (see `threadRoots`).
  useEffect(() => {
    const roots = threadRoots.current;
    for (const rootId of roots.keys()) if (!visited.includes(rootId)) roots.delete(rootId);
    for (const rootId of visited) {
      const root = conversation.messages.find((message) => message.id === rootId);
      if (root) roots.set(rootId, root);
    }
  }, [visited, conversation.messages]);
  // A host showing the thread alone (Activity) closes its own pane with the thread, and swaps the
  // thread for the conversation on "View in channel".
  const threadAlone = standaloneThread !== null;
  const threadClose = standaloneThread?.onClose ?? closeThread;
  const viewInConversation = standaloneThread?.onViewInConversation ?? showThreadRoot;
  // Outside the conversation's page only its Task popup shows; the panes stay unmounted.
  if (taskPopup) return taskLayer;
  const conversationMainPane = (
    <ThreadStoreProvider store={threads}>
      <SeenByDirectory members={conversation.mentionables}>
        <ConversationPane
          {...conversationProps}
          streamRead={windowRead}
          onOpenTask={openTaskReference}
          channelNames={channelNames}
          channels={channelList}
          jumpMessage={jumpMessage ?? jumpMessageId}
          onJumpMessageConsumed={jumpMessage ? onJumpMessageConsumed : clearJumpMessage}
          onLoadMessageAround={onLoadMessageAround}
          onReadLatest={onReadLatest}
          header={header}
          conversation={landingConversation}
          composerTarget={threadContext}
          onOpenThread={openThread}
        />
      </SeenByDirectory>
    </ThreadStoreProvider>
  );
  const conversationSidePane = visibleSlot && (
    <>
      {visibleSlot === "profile" && profileAgentId && (
        <AgentProfilePanel
          agentId={profileAgentId}
          requestedTab={agentProfile?.tab}
          onTabChange={(tab) => onAgentProfileTabChange?.(tab)}
          onClose={() => onCloseAgentProfile?.()}
        />
      )}
      {visibleSlot === "profile" && !profileAgentId && profilePersonId && (
        <PersonProfilePanel
          key={profilePersonId}
          userId={profilePersonId}
          onClose={() => onCloseAgentProfile?.()}
        />
      )}
      {/* Thread panes stay mounted under the profile so drafts and scroll survive. */}
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
              onClose={threadClose}
              threadContext={threadContext}
              onViewInConversation={() => viewInConversation(rootId)}
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
  if (!wideViewport || threadAlone) {
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state. A thread
    // shown alone fills the pane at every width without the conversation, which mounts afresh at
    // its jump message once it is shown.
    return (
      <>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!threadAlone && (
            <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", visibleSlot && "hidden")}>
              {tasksPane ?? conversationMainPane}
            </div>
          )}
          {conversationSidePane && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{conversationSidePane}</div>
          )}
        </div>
        {taskLayer}
      </>
    );
  }
  return (
    <>
      <Group
        id="conversation"
        orientation="horizontal"
        defaultLayout={threadLayout.defaultLayout}
        onLayoutChanged={threadLayout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <Panel
          id="main"
          // Strings are percentages of the group; numbers would be pixels.
          minSize="40"
          className="flex min-h-0 min-w-0 flex-col"
        >
          {tasksPane ?? conversationMainPane}
        </Panel>
        {visibleSlot && (
          <>
            <Separator
              aria-label={
                visibleSlot === "thread" ? m.conversation_thread() : m.agent_profile_resize()
              }
              className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
            />
            <Panel
              id={visibleSlot}
              defaultSize="35"
              minSize="25"
              maxSize="60"
              className="flex min-h-0 min-w-0 flex-col"
            >
              {conversationSidePane}
            </Panel>
          </>
        )}
      </Group>
      {taskLayer}
    </>
  );
}
