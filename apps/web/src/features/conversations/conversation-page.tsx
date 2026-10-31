import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import {
  adoptReadThrough,
  noteReadThrough,
} from "#src/features/cache-persistence/browser-query-cache";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { ACTIVITY_INBOX_QUERY_PREFIX } from "#src/features/inbox/activity-inbox-queries";
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { markPublicChannelRead } from "./channels.functions";
import { ChannelConversation, ChannelConversationHeader } from "./channel-conversation";
import { ConversationFilesPanel } from "./conversation-files";
import type { HeaderTabs } from "./conversation-header-tabs";
import { useMarkConversationSeen } from "./unread-store";
import type { ConversationPageTarget } from "./conversation-page-loader";
import type { ConversationPageSearch } from "./conversation-page-search";
import type { DirectConversationView } from "./conversation-types";
import { directConversationQuery, publicChannelQuery } from "./conversation-queries";
import { latestTopLevelSequence, persistReadCursor } from "./conversation-unread";
import { markDirectConversationRead } from "./conversations.functions";
import { DirectConversation, DirectConversationHeader } from "./direct-conversation";
import {
  PeopleDirectConversation,
  PeopleDirectConversationHeader,
  type PeopleDirectConversationView,
} from "./people-direct-conversation";
import { useReopenClosedOnOpen } from "./sidebar-lists";
import { useStandaloneThread } from "./standalone-thread";
import { useChannelConversation, useDirectConversation } from "./use-conversation-data";
import { useConversationView, useShownConversationTab } from "./use-conversation-view";
import { useAwaitingRestoredWindow } from "./use-conversation-open-boundary";

type ConversationPageProps = {
  search: ConversationPageSearch;
  /** The message the stream lands on, for a host that keeps it itself (the hosted pane). */
  jumpMessage?: string;
  /** Clears the host's landing once the pane has used it. */
  onJumpMessageConsumed?: () => void;
};

/**
 * A conversation as Chat opens it: its header with the Chat / Tasks / Files tabs, the stream (jumped
 * to `jumpMessage` when a host keeps the target itself), its Task board and files, and reading it.
 * Chat's routes and the hosted pane both render it, so every host shows the same page.
 */
export function ConversationPage({
  target,
  ...props
}: ConversationPageProps & { target: ConversationPageTarget }) {
  useReopenClosedOnOpen(
    target.kind === "channel"
      ? { kind: "channel", channelId: target.id }
      : { kind: "direct", conversationId: target.id },
  );
  return target.kind === "channel" ? (
    <ChannelConversationPage channelId={target.id} {...props} />
  ) : (
    <DirectConversationPage conversationId={target.id} {...props} />
  );
}

function ChannelConversationPage({
  channelId,
  ...props
}: ConversationPageProps & { channelId: string }) {
  const { page, taskView, refreshChannelAndSidebar, conversationProps } =
    useChannelConversation(channelId);
  const { conversation } = page;
  const advanceReadCursor = useServerFn(markPublicChannelRead);
  const queryClient = useQueryClient();
  useReadCursorAdoptedOnLeave("channel", channelId);
  return (
    <ConversationPageBody
      {...props}
      unreadKey={channelId}
      page={page}
      taskView={taskView}
      // Only a member advances the read cursor, creates Tasks and moves them; anyone else sees the
      // join prompt. The viewer is always a member of their own direct conversation.
      isMember={Boolean(conversation.senderMemberId)}
      name={`#${conversation.name}`}
      readCursor={{
        key: `channel:${channelId}`,
        advance: async (throughSequence) => {
          await advanceReadCursor({ data: { channelId, throughSequence } });
          noteReadThrough(
            queryClient,
            publicChannelQuery(channelId).query.queryKey,
            throughSequence,
          );
        },
      }}
      header={(tabs) => (
        <ChannelConversationHeader
          conversation={conversation}
          {...tabs}
          onChanged={refreshChannelAndSidebar}
        />
      )}
      conversation={(chat) => (
        <ChannelConversation key={channelId} {...conversationProps} {...chat} />
      )}
    />
  );
}

function DirectConversationPage({
  conversationId,
  ...props
}: ConversationPageProps & { conversationId: string }) {
  const data = useDirectConversation(conversationId);
  const { conversation } = data;
  return conversation.kind === "agent" ? (
    <AgentDirectConversationPage {...props} data={data} conversation={conversation} />
  ) : (
    <PeopleDirectConversationPage {...props} data={data} conversation={conversation} />
  );
}

function AgentDirectConversationPage({
  data,
  conversation,
  ...props
}: ConversationPageProps & {
  data: ReturnType<typeof useDirectConversation>;
  /** The page's conversation, known to be with an Agent. */
  conversation: DirectConversationView;
}) {
  const agentId = conversation.agent.id;
  const agentStatus = useLiveAgent(agentId)?.status.value;
  return (
    <DirectConversationPageBody
      {...props}
      data={data}
      name={conversation.agent.displayName}
      header={(tabs, openAgentProfile) => (
        <DirectConversationHeader
          conversation={conversation}
          {...tabs}
          onOpenAgentProfile={openAgentProfile}
          onChanged={data.page.invalidate}
        />
      )}
      conversation={(chat) => (
        <DirectConversation
          key={agentId}
          {...data.conversationProps}
          conversation={conversation}
          {...chat}
          agentStatus={agentStatus}
        />
      )}
    />
  );
}

function PeopleDirectConversationPage({
  data,
  conversation,
  ...props
}: ConversationPageProps & {
  data: ReturnType<typeof useDirectConversation>;
  /** The page's conversation, known to be between members. */
  conversation: PeopleDirectConversationView;
}) {
  return (
    <DirectConversationPageBody
      {...props}
      data={data}
      name={conversation.peer.displayName}
      header={(tabs) => (
        <PeopleDirectConversationHeader
          conversation={conversation}
          {...tabs}
          onChanged={data.page.invalidate}
        />
      )}
      // A member DM has no Agent of its own, but the chat list header opens any visible Agent's
      // profile beside whatever conversation is open: the panel needs its tab handler.
      conversation={({
        jumpMessage,
        onJumpMessageConsumed,
        tasksPane,
        onShowTasks,
        onShowFiles,
        onReadLatest,
        agentProfile,
        onAgentProfileTabChange,
        onOpenPersonProfile,
        onCloseAgentProfile,
      }) => (
        <PeopleDirectConversation
          key={conversation.conversationId}
          {...data.conversationProps}
          conversation={conversation}
          jumpMessage={jumpMessage}
          onJumpMessageConsumed={onJumpMessageConsumed}
          tasksPane={tasksPane}
          onShowTasks={onShowTasks}
          onShowFiles={onShowFiles}
          onReadLatest={onReadLatest}
          agentProfile={agentProfile}
          onAgentProfileTabChange={onAgentProfileTabChange}
          onOpenPersonProfile={onOpenPersonProfile}
          onCloseAgentProfile={onCloseAgentProfile}
        />
      )}
    />
  );
}

/**
 * What every direct message's page shares, whichever kind it is: the viewer is always a member, and
 * the sidebar badge and read cursor go by the conversation id. Each kind supplies its name, header
 * and conversation.
 */
function DirectConversationPageBody({
  data: { page, taskView },
  ...props
}: ConversationPageProps &
  Pick<ConversationPageBodyProps, "name" | "header" | "conversation"> & {
    data: ReturnType<typeof useDirectConversation>;
  }) {
  const { conversationId } = page.conversation;
  const advanceReadCursor = useServerFn(markDirectConversationRead);
  const queryClient = useQueryClient();
  useReadCursorAdoptedOnLeave("direct", conversationId);
  return (
    <ConversationPageBody
      {...props}
      unreadKey={conversationId}
      page={page}
      taskView={taskView}
      isMember
      readCursor={{
        key: `dm:${conversationId}`,
        advance: async (throughSequence) => {
          await advanceReadCursor({ data: { conversationId, throughSequence } });
          noteReadThrough(
            queryClient,
            directConversationQuery(conversationId).query.queryKey,
            throughSequence,
          );
        },
      }}
    />
  );
}

/**
 * While the conversation is open its window keeps the read cursor it opened with (the pane freezes
 * the unread divider for the visit); leaving it takes the cursor the server moved to into the
 * window, so coming back in this page load draws no divider over what was read.
 */
function useReadCursorAdoptedOnLeave(kind: "channel" | "direct", id: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const { queryKey } = (kind === "channel" ? publicChannelQuery : directConversationQuery)(
      id,
    ).query;
    return () => adoptReadThrough(queryClient, queryKey);
  }, [queryClient, kind, id]);
}

type ConversationPageData =
  | ReturnType<typeof useChannelConversation>
  | ReturnType<typeof useDirectConversation>;

/** What a conversation kind gives the shared page. */
type ConversationPageBodyProps = {
  /** The key the sidebar's unread badge is kept under: the channel id, or the direct
   * conversation's id. */
  unreadKey: string;
  page: ConversationPageData["page"];
  taskView: ConversationPageData["taskView"];
  /** Whether the viewer is a member: only a member advances the read cursor, creates Tasks and
   * moves them. */
  isMember: boolean;
  /** The conversation's name on its Task board. */
  name: string;
  readCursor: { key: string; advance: (throughSequence: number) => Promise<unknown> };
  header: (tabs: HeaderTabs, openAgentProfile: (agentId: string) => void) => ReactNode;
  conversation: (
    chat: {
      jumpMessage?: string;
      onJumpMessageConsumed?: () => void;
      tasksPane?: ReactNode;
      onShowTasks: () => void;
      onShowFiles: () => void;
      onReadLatest: (throughSequence: number) => void;
    } & ReturnType<typeof useConversationAgentProfile>,
  ) => ReactNode;
};

/**
 * The page both kinds share: the tab in view, reading the conversation, the Files and Tasks tabs,
 * and the chat with its thread, Task popup and Agent profile. Each kind supplies its data, header,
 * conversation and read cursor.
 */
function ConversationPageBody({
  search: pageSearch,
  jumpMessage,
  onJumpMessageConsumed,
  unreadKey,
  page,
  taskView,
  isMember,
  name,
  readCursor,
  header,
  conversation: renderConversation,
}: ConversationPageProps & ConversationPageBodyProps) {
  const { view: requestedView, profile, agentTab, ...search } = pageSearch;
  const view = useShownConversationTab(requestedView);
  const agentProfile = useConversationAgentProfile({ profile, agentTab });
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  // Opening the conversation clears its badge and advances the server cursor through the loaded
  // top-level end. A thread shown alone leaves the conversation out of view, so it stays unread.
  const markSeen = useMarkConversationSeen();
  const threadAlone = useStandaloneThread() !== null;
  const topLevelEnd = latestTopLevelSequence(conversation.messages);
  useEffect(() => {
    if (threadAlone) return;
    markSeen(unreadKey, topLevelEnd);
  }, [markSeen, unreadKey, topLevelEnd, threadAlone]);
  // A conversation opened from Activity is read here, not by its row (task #358), so its first
  // read in each visit refreshes Activity, and so does reading to the latest. Not every message that
  // arrives while it is open: that would refetch Activity's whole list per message.
  const queryClient = useQueryClient();
  const refreshedActivity = useRef<string | undefined>(undefined);
  const advance = (throughSequence: number, label: string, refreshActivity: boolean) =>
    void persistReadCursor(() => readCursor.advance(throughSequence), label).then(() => {
      if (refreshActivity)
        void queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX });
    });
  // The cursor's write is rebuilt each render around the same conversation; the effect reruns only
  // when what it reads changes. It waits, like the divider, for a stored copy's own read: moving the
  // server's cursor first would bring that read back with nothing unread.
  const readThrough = useEffectEvent((throughSequence: number) => {
    const first = refreshedActivity.current !== readCursor.key;
    refreshedActivity.current = readCursor.key;
    advance(throughSequence, readCursor.key, first);
  });
  const restoring = useAwaitingRestoredWindow(conversation.conversationId);
  useEffect(() => {
    if (!topLevelEnd || !isMember || threadAlone || restoring) return;
    readThrough(topLevelEnd);
  }, [readCursor.key, topLevelEnd, isMember, threadAlone, restoring]);
  // Reading to the latest waits for a stored copy's own read too (task #358).
  const readLatest = (throughSequence: number) => {
    if (!isMember || restoring) return;
    advance(throughSequence, `${readCursor.key}:latest`, true);
  };
  const { onOpenAgentProfile } = agentProfile;

  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header(
          { active: "files", onShowChat: showChat, onShowTasks: showTasks },
          onOpenAgentProfile,
        )}
        <ConversationFilesPanel
          conversationId={conversation.conversationId}
          onOpenMessage={openMessage}
        />
      </div>
    );
  // The Tasks tab sits in the conversation's main pane, so a Task opened from it shows the
  // conversation's Task popup over the board.
  const tasksPane =
    view === "tasks" ? (
      <ConversationTaskBoard
        conversationId={conversation.conversationId}
        header={header(
          { active: "tasks", onShowChat: showChat, onShowFiles: showFiles },
          onOpenAgentProfile,
        )}
        search={search}
        taskView={taskView}
        name={name}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate={isMember}
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={
          isMember
            ? async (titles, idempotencyKey) => {
                const tasks = await taskView.command({
                  operation: "create",
                  titles,
                  idempotencyKey,
                });
                await page.invalidate();
                return tasks;
              }
            : undefined
        }
      />
    ) : undefined;
  return renderConversation({
    jumpMessage,
    onJumpMessageConsumed,
    tasksPane,
    onShowTasks: showTasks,
    onShowFiles: showFiles,
    onReadLatest: readLatest,
    ...agentProfile,
  });
}
