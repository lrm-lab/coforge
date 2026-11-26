import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { ACTIVITY_INBOX_LISTS_KEY } from "#src/features/inbox/activity-inbox-queries";
import { ArtifactsBesideChat } from "#src/features/artifacts/artifact-beside-chat";
import { ConversationArtifactSplit } from "#src/features/artifacts/artifact-side-pane";
import { ConversationFilesPanel } from "./conversation-files";
import { activityItemKey } from "#src/features/inbox/activity-unread-count";
import { useReportViewingItem } from "#src/features/inbox/viewing-items";
import { usePageTitleLabel } from "#src/lib/browser-tab";
import { m } from "#src/paraglide/messages";
import { markPublicChannelRead } from "./channels.functions";
import { ChannelConversation, ChannelConversationHeader } from "./channel-conversation";
import type { HeaderTabs } from "./conversation-header-tabs";
import { channelLabel } from "./channel-visibility";
import { useMarkConversationSeen } from "./unread-store";
import type { ConversationPageTarget } from "./conversation-page-loader";
import type { ConversationPageSearch } from "./conversation-page-search";
import type { DirectConversationView } from "./conversation-types";
import { markOpenReadStale } from "./conversation-open-query";
import { persistReadCursor, rowReadEnd } from "./conversation-unread";
import { markDirectConversationRead } from "./conversations.functions";
import { DirectConversation, DirectConversationHeader } from "./direct-conversation";
import {
  PeopleDirectConversation,
  PeopleDirectConversationHeader,
  type PeopleDirectConversationView,
} from "./people-direct-conversation";
import { useClearSidebarTopLevelUnread, useReopenClosedOnOpen } from "./sidebar-lists";
import { useStandaloneThread } from "./standalone-thread";
import { useChannelConversation, useDirectConversation } from "./use-conversation-data";
import { useChannelMentionables } from "./use-channel-mentionables";
import { useConversationView, useShownConversationTab } from "./use-conversation-view";
import { useConversationOpened } from "./use-conversation-open";
import { usePageAttended } from "./use-page-attended";
import { useConversationDetailsState } from "./use-conversation-details-state";

const LazyConversationTaskBoard = lazy(() =>
  import("#src/features/tasks/conversation-task-board").then((mod) => ({
    default: mod.ConversationTaskBoard,
  })),
);

type ConversationPageProps = {
  search: ConversationPageSearch;
  jumpMessage?: string;
  onJumpMessageConsumed?: () => void;
  hosted?: boolean;
};

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
  const { page, taskView, conversationProps } = useChannelConversation(channelId);
  const { conversation } = page;
  const freshMentionables = useChannelMentionables(channelId, conversation.mentionables);
  const freshConversation = useMemo(
    () => ({
      ...conversation,
      mentionables: freshMentionables ?? conversation.mentionables,
    }),
    [conversation, freshMentionables],
  );
  const freshPage = useMemo(
    () => ({ ...page, conversation: freshConversation }),
    [page, freshConversation],
  );
  const advanceReadCursor = useServerFn(markPublicChannelRead);
  return (
    <ConversationPageBody
      {...props}
      unreadKey={channelId}
      page={freshPage}
      taskView={taskView}
      isMember={Boolean(conversation.senderMemberId)}
      name={channelLabel(conversation)}
      tabLabel={conversation.name}
      readCursor={{
        key: `channel:${channelId}`,
        advance: (throughSequence) => advanceReadCursor({ data: { channelId, throughSequence } }),
      }}
      header={(tabs, _openAgentProfile, details) => (
        <ChannelConversationHeader
          conversation={freshConversation}
          {...tabs}
          settingsOpen={details.settingsOpen}
          onOpenSettings={details.openDetails}
          onCloseSettings={details.closeDetails}
        />
      )}
      conversation={(chat) => (
        <ChannelConversation
          key={channelId}
          {...conversationProps}
          conversation={freshConversation}
          {...chat}
        />
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
  conversation: DirectConversationView;
}) {
  const agentId = conversation.agent.id;
  return (
    <DirectConversationPageBody
      {...props}
      data={data}
      name={conversation.agent.displayName}
      tabLabel={`@${conversation.agent.name}`}
      header={(tabs, openAgentProfile, details) => (
        <DirectConversationHeader
          conversation={conversation}
          {...tabs}
          onOpenAgentProfile={openAgentProfile}
          settingsOpen={details.settingsOpen}
          onToggleSettings={details.toggleDetails}
        />
      )}
      conversation={(chat) => (
        <DirectConversation
          key={agentId}
          {...data.conversationProps}
          conversation={conversation}
          {...chat}
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
  conversation: PeopleDirectConversationView;
}) {
  return (
    <DirectConversationPageBody
      {...props}
      data={data}
      name={conversation.peer.displayName}
      tabLabel={conversation.peer.displayName}
      header={(tabs, _openAgentProfile, details) => (
        <PeopleDirectConversationHeader
          conversation={conversation}
          {...tabs}
          settingsOpen={details.settingsOpen}
          onToggleSettings={details.toggleDetails}
        />
      )}
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

function DirectConversationPageBody({
  data: { page, taskView },
  ...props
}: ConversationPageProps &
  Pick<ConversationPageBodyProps, "name" | "tabLabel" | "header" | "conversation"> & {
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
      isMember
      direct
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

type ConversationPageBodyProps = {
  unreadKey: string;
  page: ConversationPageData["page"];
  taskView: ConversationPageData["taskView"];
  isMember: boolean;
  direct?: boolean;
  name: string;
  tabLabel: string;
  readCursor: { key: string; advance: (throughSequence: number) => Promise<unknown> };
  header: (
    tabs: HeaderTabs,
    openAgentProfile: (agentId: string) => void,
    details: {
      settingsOpen: boolean;
      openDetails: (view?: "members" | "add" | null) => void;
      closeDetails: () => void;
      toggleDetails: () => void;
    },
  ) => ReactNode;
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

function ConversationPageBody(props: ConversationPageProps & ConversationPageBodyProps) {
  const { doc, docFull } = props.search;
  return (
    <ArtifactsBesideChat>
      <ConversationArtifactSplit
        chat={<ConversationPageMain {...props} />}
        conversationId={props.page.conversation.conversationId}
        search={{ doc, docFull }}
      />
    </ArtifactsBesideChat>
  );
}

function ConversationPageMain({
  search: pageSearch,
  jumpMessage,
  onJumpMessageConsumed,
  hosted,
  unreadKey,
  page,
  taskView,
  isMember,
  direct,
  name,
  tabLabel,
  readCursor,
  header,
  conversation: renderConversation,
}: ConversationPageProps & ConversationPageBodyProps) {
  const {
    view: requestedView,
    profile,
    agentTab,
    details: _details,
    doc: _doc,
    docFull: _docFull,
    ...search
  } = pageSearch;
  const view = useShownConversationTab(requestedView);
  const agentProfile = useConversationAgentProfile({ profile, agentTab });
  const details = useConversationDetailsState();
  const detailsControls = {
    settingsOpen: details.open,
    openDetails: (view?: "members" | "add" | null) => details.openDetails(view ?? "panel"),
    closeDetails: details.closeDetails,
    toggleDetails: details.toggleDetails,
  };
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  const markSeen = useMarkConversationSeen();
  const clearSidebarTopLevelUnread = useClearSidebarTopLevelUnread();
  const threadAlone = useStandaloneThread() !== null;
  const threadOpen = threadAlone || pageSearch.threadRootId !== undefined;
  usePageTitleLabel(
    hosted && !threadAlone
      ? undefined
      : `${tabLabel}${threadOpen ? ` - ${m.conversation_thread()}` : ""}`,
  );
  const readEnd = rowReadEnd(conversation, direct === true);
  useEffect(() => {
    if (threadAlone) return;
    markSeen(unreadKey, readEnd);
    if (isMember) clearSidebarTopLevelUnread(unreadKey);
  }, [markSeen, clearSidebarTopLevelUnread, isMember, unreadKey, readEnd, threadAlone]);
  const queryClient = useQueryClient();
  const refreshedActivity = useRef<string | undefined>(undefined);
  const advance = (throughSequence: number, label: string, refreshActivity: boolean) =>
    void persistReadCursor(() => readCursor.advance(throughSequence), label).then(() => {
      markOpenReadStale(queryClient, conversation.conversationId);
      if (refreshActivity)
        void queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_LISTS_KEY });
    });
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
  const attended = usePageAttended();
  useReportViewingItem(
    isMember && !threadAlone && opened && attended
      ? activityItemKey({ conversationId: conversation.conversationId })
      : undefined,
  );
  useEffect(() => {
    if (!readEnd || !isMember || threadAlone || !opened || !attended) return;
    readThrough(readEnd);
  }, [readCursor.key, readEnd, isMember, threadAlone, opened, attended]);
  const readLatest = (throughSequence: number) => {
    if (!isMember || !opened) return;
    advance(Math.max(throughSequence, readEnd), `${readCursor.key}:latest`, true);
  };
  const { onOpenAgentProfile } = agentProfile;

  const tasksPane =
    view === "files" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        {header(
          { active: "files", onShowChat: showChat, onShowTasks: showTasks },
          onOpenAgentProfile,
          detailsControls,
        )}
        <ConversationFilesPanel
          conversationId={conversation.conversationId}
          onOpenMessage={openMessage}
        />
      </div>
    ) : view === "tasks" ? (
      <Suspense fallback={null}>
        <LazyConversationTaskBoard
          conversationId={conversation.conversationId}
          header={header(
            { active: "tasks", onShowChat: showChat, onShowFiles: showFiles },
            onOpenAgentProfile,
            detailsControls,
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
              ? async (draft, idempotencyKey) => {
                  const tasks = await taskView.command({
                    operation: "create",
                    ...draft,
                    idempotencyKey,
                  });
                  await page.invalidate();
                  return tasks;
                }
              : undefined
          }
        />
      </Suspense>
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
