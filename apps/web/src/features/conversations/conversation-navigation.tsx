import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useSuspenseQuery } from "@tanstack/react-query";
import { BadgeWithIcon } from "#src/components/base/badges/badges";
import { PageHeader } from "#src/components/layout/page-header";
import { ChatListShownContext, useReportChatListOpen } from "#src/components/layout/phone-shell";
import { TabHomeHeader } from "#src/components/layout/tab-home-header";
import { Spinner } from "#src/components/ui/spinner";
import { ConnectionStatusPill } from "#src/features/realtime/connection-status-pill";
import { SearchField } from "#src/features/search/search-field";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { ChatHeaderBusyAgents } from "./chat-header-busy-agents";
import { ConversationFocusContext, useConversationFocusState } from "./conversation-focus";
import { ConversationListContext } from "./conversation-list-button";
import { ConversationListResizeHandle } from "./conversation-list-resize-handle";
import { LIST_COLUMN_CLASS } from "./conversation-list-width";
import { ConversationDirectory } from "./conversation-directory";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { createPublicChannel } from "./channels.functions";
import { ConversationHostProvider } from "./conversation-host";
import {
  useCurrentWorkspaceId,
  useVisibleAgentDirectory,
  useRefreshAgentDirectory,
} from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { CreateChannelDialog } from "./create-channel-dialog";
import { NewConversationMenu } from "./new-conversation-menu";
import { channelNamesQuery } from "./conversation-queries";
import { rememberConversation } from "./last-conversation";
import { unknownAgentOf, unreadIdsToKeep, type SeededList } from "./conversation-unread";
import { useChannelUnread } from "./use-channel-unread";
import { UnreadStoreContext } from "./unread-store";
import {
  useApplyChannelSignal,
  useApplyConversationActivity,
  useApplyMarkedEvent,
  useListReadPosition,
  useRefreshSidebar,
  useSavesRetrying,
  useSidebarLists,
} from "./sidebar-lists";
import { listedDirectIds } from "./sidebar-rows";
import { workspacePath } from "#src/features/workspaces/workspace-url";

export function useConversationDetailVisible() {
  return useContext(ConversationListContext)?.detailVisible ?? true;
}

export function useConversationListVisible() {
  return useContext(ConversationListContext)?.listVisible ?? true;
}

export function useCloseConversationList(): () => void {
  const navigation = useContext(ConversationListContext);
  return navigation?.closeList ?? (() => {});
}

export function ConversationNavigation({ children }: { children: ReactNode }) {
  const { channels, directs, viewerId, readAt } = useSidebarLists();
  const agents = useVisibleAgentDirectory();
  const refreshAgentDirectory = useRefreshAgentDirectory();
  const workspaceId = useCurrentWorkspaceId();
  const channelNames = useSuspenseQuery(channelNamesQuery(workspaceId ?? "")).data;
  const workspaceSlug = useWorkspaceSlug();
  const desktop = useBreakpoint("lg");
  const shellShowsList = useContext(ChatListShownContext);
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const openThreadRootId = useRouterState({
    select: (state) => {
      const raw = (state.location.search as { threadRootId?: unknown }).threadRootId;
      return typeof raw === "string" && raw.length > 0 ? raw : undefined;
    },
  });
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const slot = useRouterState({
    select: ({ location: { search } }) =>
      `${"threadRootId" in search ? search.threadRootId : ""}|${"profile" in search ? JSON.stringify(search.profile) : ""}`,
  });
  const focus = useConversationFocusState(`${pathname}|${slot}`, desktop);
  const create = useServerFn(createPublicChannel);
  const channel = useParams({
    from: "/w/$workspaceSlug/_chat/channel/$channelId",
    shouldThrow: false,
  });
  const openDm = useParams({ from: "/w/$workspaceSlug/_chat/dm/$dmId", shouldThrow: false });
  const showList =
    browsing ||
    pathname === workspacePath(workspaceSlug) ||
    pathname === workspacePath(workspaceSlug, "/");
  useEffect(() => {
    let pathname = router.state.location.pathname;
    return router.subscribe("onResolved", () => {
      const next = router.state.location.pathname;
      if (next === pathname) return;
      pathname = next;
      setBrowsing(false);
    });
  }, [router]);

  const rememberedPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!workspaceId || pathname === rememberedPath.current) return;
    if (!pathname.startsWith(workspacePath(workspaceSlug, "/"))) return;
    rememberedPath.current = pathname;
    rememberConversation(workspaceId, pathname);
  }, [workspaceId, workspaceSlug, pathname]);

  const visibleChannels = useMemo(() => channels.filter((listed) => !listed.archived), [channels]);
  const listedConversationIds = useMemo(
    () => new Set([...visibleChannels.map((row) => row.id), ...listedDirectIds(directs, agents)]),
    [visibleChannels, directs, agents],
  );
  const refreshSidebar = useRefreshSidebar();
  const readPosition = useListReadPosition();
  const applyChannelSignal = useApplyChannelSignal();
  const applyConversationActivity = useApplyConversationActivity();
  const applyMarkedEvent = useApplyMarkedEvent();
  const knownAgentIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const rosterRefresh = useRef<Promise<void> | undefined>(undefined);
  const unread = useChannelUnread({
    workspaceId,
    userId: viewerId,
    channels: visibleChannels,
    openConversationId: channel?.channelId ?? openDm?.dmId,
    openThreadRootId,
    listedConversationIds,
    onClosedConversationActivity: (lists, event) => {
      void refreshSidebar(lists);
      if (unknownAgentOf(event, knownAgentIds) && !rosterRefresh.current)
        rosterRefresh.current = refreshAgentDirectory()
          .catch(() => undefined)
          .finally(() => {
            rosterRefresh.current = undefined;
          });
    },
    onConversationActivity: applyConversationActivity,
    onConversationMarked: applyMarkedEvent,
    onChannelSignal: applyChannelSignal,
    onSidebarListsChanged: (lists) => void refreshSidebar(lists),
    readPosition,
  });
  const refresh = unread.replace;
  const seed = useMemo(() => {
    const lists: SeededList[] = [
      {
        readAt: readAt.channels,
        rows: visibleChannels.map((listed) => ({ id: listed.id, unreadCount: listed.unreadCount })),
      },
      {
        readAt: readAt.dms,
        rows: Object.entries(directs.unread).map(([conversationId, unreadCount]) => ({
          id: conversationId,
          unreadCount,
        })),
      },
    ];
    const entries = lists.flatMap((list) => list.rows);
    const counts = entries
      .flatMap((entry) =>
        entry.unreadCount && entry.unreadCount > 0 ? [`${entry.id}:${entry.unreadCount}`] : [],
      )
      .join(",");
    return { lists, entries, key: `${readAt.channels}:${readAt.dms}|${counts}` };
  }, [visibleChannels, directs, readAt.channels, readAt.dms]);
  const lastSeed = useRef<readonly SeededList[] | undefined>(undefined);
  useEffect(() => {
    refresh(seed.entries, unreadIdsToKeep(seed.lists, lastSeed.current));
    lastSeed.current = seed.lists;
  }, [refresh, seed.key]);
  const detailVisible = desktop || !showList;
  useReportChatListOpen(showList);
  const listVisible = desktop || shellShowsList;
  const listControls = useMemo(
    () => ({
      showList: () => setBrowsing(true),
      closeList: () => setBrowsing(false),
      detailVisible,
      listVisible,
      listBesideFrom: "lg" as const,
    }),
    [detailVisible, listVisible],
  );
  return (
    <ConversationListContext value={listControls}>
      <ConversationFocusContext value={focus}>
        <ConversationHostProvider channels={channelNames}>
          <UnreadStoreContext value={unread.store}>
            <main
              data-panel-cards
              data-chat-cards
              data-focus={focus.focused}
              className="group/chat flex h-full min-w-0 flex-col bg-primary lg:flex-row lg:gap-2 lg:bg-transparent"
            >
              <section
                className={cx(
                  "relative min-h-0 flex-1 flex-col lg:flex lg:flex-none lg:overflow-hidden lg:rounded-xl lg:bg-primary",
                  LIST_COLUMN_CLASS,
                  showList ? "flex" : "hidden",
                  "lg:group-has-[[data-crowd-list]]/chat:hidden",
                  "lg:group-data-[focus]/chat:hidden",
                )}
              >
                {desktop ? (
                  <PageHeader
                    heading={m.navigation_chat()}
                    meta={
                      <>
                        <ConnectionStatusPill whenConnected={<SavingChangesBadge />} />
                        <ChatHeaderBusyAgents
                          directs={directs}
                          onConversationPage={Boolean(channel || openDm)}
                        />
                      </>
                    }
                    actions={<NewConversationMenu onCreateChannel={() => setCreating(true)} />}
                  />
                ) : (
                  <>
                    <TabHomeHeader
                      title={m.navigation_chat_short()}
                      meta={<ConnectionStatusPill whenConnected={<SavingChangesBadge />} />}
                      agents={
                        <ChatHeaderBusyAgents
                          directs={directs}
                          onConversationPage={Boolean(channel || openDm)}
                        />
                      }
                      actions={<NewConversationMenu onCreateChannel={() => setCreating(true)} />}
                    />
                    <div className="shrink-0 px-page py-2">
                      <SearchField />
                    </div>
                  </>
                )}
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-3 pb-4">
                  <ConversationDirectory
                    channels={visibleChannels}
                    agents={agents}
                    directRows={directs.rows}
                    viewerId={viewerId}
                    selectedChannelId={channel?.channelId}
                    selectedDmId={openDm?.dmId}
                    selectedSaved={pathname === workspacePath(workspaceSlug, "/saved")}
                    selectedDrafts={pathname === workspacePath(workspaceSlug, "/drafts")}
                  />
                </div>
                <ConversationListResizeHandle />
              </section>
              <div
                className={cx(
                  "min-h-0 min-w-0 flex-1 flex-col lg:flex lg:overflow-hidden lg:rounded-xl lg:bg-primary",
                  showList ? "hidden" : "flex",
                )}
              >
                {children}
              </div>
            </main>
            {creating && (
              <CreateChannelDialog
                open={creating}
                onOpenChange={setCreating}
                memberPicker
                minMembers={2}
                offersPrivate
                onCreate={async (name, memberUserIds, memberAgentIds, visibility) => {
                  const created = await create({
                    data: {
                      name,
                      visibility,
                      userIds: memberUserIds ?? [],
                      agentIds: memberAgentIds ?? [],
                    },
                  });
                  const sidebarRefreshed = await refreshSidebar(["channels", "channelNames"]).then(
                    () => true,
                    () => false,
                  );
                  return { ...created, sidebarRefreshed };
                }}
                onOpenChannel={(channelId) =>
                  router.navigate({
                    to: "/w/$workspaceSlug/channel/$channelId",
                    params: { workspaceSlug, channelId },
                  })
                }
              />
            )}
          </UnreadStoreContext>
        </ConversationHostProvider>
      </ConversationFocusContext>
    </ConversationListContext>
  );
}

function SavingChangesBadge() {
  const count = useSavesRetrying();
  if (count === 0) return null;
  return (
    <BadgeWithIcon size="sm" color="gray" iconLeading={Spinner}>
      {m.chat_saving_changes({ count })}
    </BadgeWithIcon>
  );
}
