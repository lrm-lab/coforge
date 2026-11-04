import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { ACTIVITY_INBOX_QUERY_PREFIX } from "#src/features/inbox/activity-inbox-queries";
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { ArtifactDraftPane } from "#src/features/artifacts/artifact-draft-pane";
import { ArtifactPane } from "#src/features/artifacts/artifact-pane";
import { useArtifactsOn } from "#src/features/artifacts/artifact-queries";
import { ConversationFilesWithDocuments } from "#src/features/artifacts/artifact-files";
import { cn } from "#src/lib/utils";
import { markPublicChannelRead } from "./channels.functions";
import { ChannelConversation, ChannelConversationHeader } from "./channel-conversation";
import { ConversationFilesPanel } from "./conversation-files";
import type { HeaderTabs } from "./conversation-header-tabs";
import { channelLabel } from "./channel-visibility";
import { useMarkConversationSeen } from "./unread-store";
import type { ConversationPageTarget } from "./conversation-page-loader";
import type { ConversationPageSearch } from "./conversation-page-search";
import type { DirectConversationView } from "./conversation-types";
import { markOpenReadStale } from "./conversation-open-query";
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
import { useConversationOpened } from "./use-conversation-open";

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
  return (
    <ConversationPageBody
      {...props}
      unreadKey={channelId}
      page={page}
      taskView={taskView}
      // Only a member advances the read cursor, creates Tasks and moves them; anyone else sees the
      // join prompt. The viewer is always a member of their own direct conversation.
      isMember={Boolean(conversation.senderMemberId)}
      name={channelLabel(conversation)}
      readCursor={{
        key: `channel:${channelId}`,
        advance: (throughSequence) => advanceReadCursor({ data: { channelId, throughSequence } }),
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
  return (
    <ConversationPageBody
      {...props}
      unreadKey={conversationId}
      page={page}
      taskView={taskView}
      direct
      isMember
      readCursor={{
        key: `dm:${conversationId}`,
        advance: (throughSequence) =>
          advanceReadCursor({ data: { conversationId, throughSequence } }),
      }}
    />
  );
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
  /** A direct conversation: its Tasks are filed under no Project. */
  direct?: boolean;
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
function ConversationPageBody(props: ConversationPageProps & ConversationPageBodyProps) {
  const { doc, docVersion, docFull, docHistory, docDraft } = props.search;
  const documents = useArtifactsOn() === true;
  const open = documents && (doc !== undefined || docDraft === true);
  // The chat keeps one place in the tree whether a document is open or not, so opening one, going
  // full screen or opening its history only hides the chat: its scroll, open thread and draft stay.
  // An open document sits beside it, or alone in full screen (task #385).
  return (
    <div className="@container/page flex min-h-0 min-w-0 flex-1">
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          open && docFull && "hidden",
          // With the history open, the chat shows only where it still has room (ArtifactPane).
          open && !docFull && docHistory && "hidden @6xl/page:flex",
        )}
      >
        <ConversationPageMain {...props} documents={documents} />
      </div>
      {open &&
        (doc ? (
          <ArtifactPane search={{ doc, docVersion, docFull, docHistory }} />
        ) : (
          <ArtifactDraftPane
            // A draft belongs to its conversation: another one starts its own.
            key={props.page.conversation.conversationId}
            conversationId={props.page.conversation.conversationId}
            search={{ docFull }}
          />
        ))}
    </div>
  );
}

function ConversationPageMain({
  search: pageSearch,
  jumpMessage,
  onJumpMessageConsumed,
  unreadKey,
  page,
  taskView,
  isMember,
  name,
  direct,
  readCursor,
  header,
  conversation: renderConversation,
  documents,
}: ConversationPageProps & ConversationPageBodyProps & { documents: boolean }) {
  const {
    view: requestedView,
    profile,
    agentTab,
    doc: _doc,
    docVersion: _docVersion,
    docFull: _docFull,
    docHistory: _docHistory,
    docDraft: _docDraft,
    ...search
  } = pageSearch;
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
      markOpenReadStale(queryClient, conversation.conversationId);
      if (refreshActivity)
        void queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX });
    });
  // The cursor's write is rebuilt each render around the same conversation; the effect reruns only
  // when what it reads changes. It waits, like the divider, for this open's read of where the
  // viewer's unread starts (task #378): moving the server's cursor first would bring that read back
  // with nothing unread.
  const readThrough = useEffectEvent((throughSequence: number) => {
    const first = refreshedActivity.current !== readCursor.key;
    refreshedActivity.current = readCursor.key;
    advance(throughSequence, readCursor.key, first);
  });
  const opened = useConversationOpened(
    conversation.conversationId,
    undefined,
    isMember && !threadAlone,
  );
  useEffect(() => {
    if (!topLevelEnd || !isMember || threadAlone || !opened) return;
    readThrough(topLevelEnd);
  }, [readCursor.key, topLevelEnd, isMember, threadAlone, opened]);
  const readLatest = (throughSequence: number) => {
    if (!isMember || !opened) return;
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
        {documents ? (
          <ConversationFilesWithDocuments
            conversationId={conversation.conversationId}
            canCreate={isMember}
            onOpenMessage={openMessage}
          />
        ) : (
          <ConversationFilesPanel
            conversationId={conversation.conversationId}
            onOpenMessage={openMessage}
          />
        )}
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
        direct={direct}
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
