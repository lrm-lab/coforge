import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { inArray, useLiveQuery } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  chatListQueryKey,
  createSidebar,
  listReadPosition,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type ChannelRow,
  type Sidebar,
} from "./sidebar-collections";
import type { PinRef } from "./pinned-conversations";
import {
  applyChannelSignalToLists,
  applyConversationActivityToRow,
  applyMarkedEventToSidebar,
  clearSidebarTopLevelUnread,
} from "./sidebar-signals";
import type { MarkedEventUnreadPayload } from "./sidebar-unread-state";
import { directListsOf, type DirectRow, type ListedDirect } from "./sidebar-rows";
import { rowListenersOf, type ChangingRows } from "./sidebar-row-listeners";
import { sidebarRefreshQueue, type ChatList } from "./conversation-unread";
import type { ConversationActivityEvent } from "./conversation-activity-event";
import { compareChannelNames, type ChannelSignal } from "./channel-signals";
import {
  chatSectionOrderQuery,
  chatSectionOrderReady,
  chatSectionsQuery,
  chatSectionsStatus,
} from "./chat-sections";

const sidebarsByClient = new WeakMap<QueryClient, Map<string, Sidebar>>();

function sidebarFor(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = sidebarsByClient.get(queryClient);
  if (!byWorkspace) sidebarsByClient.set(queryClient, (byWorkspace = new Map()));
  let sidebar = byWorkspace.get(workspaceId);
  if (!sidebar) byWorkspace.set(workspaceId, (sidebar = createSidebar(queryClient, workspaceId)));
  return sidebar;
}

function useSidebar() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return sidebarFor(queryClient, workspaceId);
}

type ListedChannel = Omit<ChannelRow, "lastMessage">;

const NO_ROWS: readonly never[] = [];
const EMPTY_TIMES: ReadonlyMap<string, string | null> = new Map();

function cachedChannelRows(queryClient: QueryClient, workspaceId: string): readonly ChannelRow[] {
  return queryClient.getQueryData(sidebarChannelsQuery(workspaceId).queryKey)?.rows ?? NO_ROWS;
}
function cachedDirectRows(queryClient: QueryClient, workspaceId: string): readonly DirectRow[] {
  return queryClient.getQueryData(sidebarDirectsQuery(workspaceId).queryKey)?.rows ?? NO_ROWS;
}

export function useSidebarLists() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const queryClient = useQueryClient();
  const channelsReadAt = useSuspenseQuery({
    ...sidebarChannelsQuery(workspaceId),
    select: (read) => read.fetchedAt,
  }).data;
  const directsRead = useSuspenseQuery({
    ...sidebarDirectsQuery(workspaceId),
    select: ({ fetchedAt, viewerId }) => ({ fetchedAt, viewerId }),
  }).data;
  const sidebar = useSidebar();
  const liveChannels = useLiveQuery({
    queryKey: ["sidebar-channels", workspaceId],
    query: (q) =>
      q.from({ row: sidebar.channels }).select(({ row }) => ({ ...row, lastMessage: null })),
  });
  const liveDirects = useLiveQuery({
    queryKey: ["sidebar-directs", workspaceId],
    query: (q) =>
      q.from({ row: sidebar.directs }).select(({ row }) => ({
        ...row,
        lastMessageAt: null,
        lastMessagePreview: null,
        lastMessageNotice: null,
        lastMessageCard: null,
      })),
  });
  const channelRows: readonly ListedChannel[] =
    (liveChannels.isReady && liveChannels.data) || cachedChannelRows(queryClient, workspaceId);
  const directRows: readonly ListedDirect[] =
    (liveDirects.isReady && liveDirects.data) || cachedDirectRows(queryClient, workspaceId);
  const channels = useMemo(
    () =>
      [...channelRows]
        .sort((left, right) => compareChannelNames(left.name, right.name))
        .filter((channel) => !channel.hidden || channel.pinned),
    [channelRows],
  );
  const directs = useMemo(() => directListsOf(directRows), [directRows]);
  return {
    channels,
    directs,
    viewerId: directsRead.viewerId,
    readAt: { channels: channelsReadAt, dms: directsRead.fetchedAt },
  };
}

function useViewerId() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useSuspenseQuery({
    ...sidebarDirectsQuery(workspaceId),
    select: (read) => read.viewerId,
  }).data;
}

type RowSource<Row> = ChangingRows & { isReady(): boolean; get(key: string): Row | undefined };

function useLiveRow<Row>(
  rows: RowSource<Row>,
  key: string,
  cached: readonly Row[],
  keyOf: (row: Row) => string,
): Row | undefined {
  const listeners = rowListenersOf(rows);
  const subscribe = useCallback(
    (listener: () => void) => listeners.subscribe(key, listener),
    [listeners, key],
  );
  const read = () => (rows.isReady() ? rows.get(key) : cached.find((row) => keyOf(row) === key));
  return useSyncExternalStore(subscribe, read, read);
}

export function useLiveChannelRow(channelId: string): ChannelRow | undefined {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const cached = cachedChannelRows(queryClient, workspaceId);
  return useLiveRow(useSidebar().channels, channelId, cached, (row) => row.id);
}

export function useLiveDirectRow(conversationId: string): DirectRow | undefined {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const cached = cachedDirectRows(queryClient, workspaceId);
  return useLiveRow(useSidebar().directs, conversationId, cached, (row) => row.conversationId);
}

export function useLastMessageTimes({
  channelIds,
  directIds,
}: {
  channelIds: readonly string[];
  directIds: readonly string[];
}): ReadonlyMap<string, string | null> {
  const sidebar = useSidebar();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const wantedChannels = useMemo(() => [...new Set(channelIds)].sort(), [channelIds]);
  const wantedDirects = useMemo(() => [...new Set(directIds)].sort(), [directIds]);
  const channelKey = wantedChannels.join(",");
  const directKey = wantedDirects.join(",");
  const channels = useLiveQuery({
    queryKey: ["sidebar-channel-times", workspaceId, channelKey],
    query: (q) =>
      wantedChannels.length === 0
        ? undefined
        : q
            .from({ row: sidebar.channels })
            .where(({ row }) => inArray(row.id, wantedChannels))
            .select(({ row }) => ({ id: row.id, at: row.lastMessage?.createdAt })),
  });
  const directs = useLiveQuery({
    queryKey: ["sidebar-direct-times", workspaceId, directKey],
    query: (q) =>
      wantedDirects.length === 0
        ? undefined
        : q
            .from({ row: sidebar.directs })
            .where(({ row }) => inArray(row.conversationId, wantedDirects))
            .select(({ row }) => ({ id: row.conversationId, at: row.lastMessageAt })),
  });
  return useMemo(() => {
    if (wantedChannels.length === 0 && wantedDirects.length === 0) return EMPTY_TIMES;
    const channelTimes =
      wantedChannels.length === 0
        ? NO_ROWS
        : channels.isReady
          ? (channels.data ?? NO_ROWS)
          : cachedChannelRows(queryClient, workspaceId).map((row) => ({
              id: row.id,
              at: row.lastMessage?.createdAt,
            }));
    const directTimes =
      wantedDirects.length === 0
        ? NO_ROWS
        : directs.isReady
          ? (directs.data ?? NO_ROWS)
          : cachedDirectRows(queryClient, workspaceId).map((row) => ({
              id: row.conversationId,
              at: row.lastMessageAt,
            }));
    const map = new Map<string, string | null>();
    for (const row of channelTimes) map.set(row.id, row.at ?? null);
    for (const row of directTimes) map.set(row.id, row.at ?? null);
    return map;
  }, [
    wantedChannels.length,
    wantedDirects.length,
    channels.isReady,
    channels.data,
    directs.isReady,
    directs.data,
    queryClient,
    workspaceId,
  ]);
}

const lastOpened = new WeakMap<object, string>();

export function useReopenClosedOnOpen(target: PinRef) {
  const sidebar = useSidebar();
  const id = target.kind === "channel" ? target.channelId : target.conversationId;
  useEffect(() => {
    if (lastOpened.get(sidebar) === id) return;
    lastOpened.set(sidebar, id);
    const list = target.kind === "channel" ? sidebar.channels : sidebar.directs;
    void list.stateWhenReady().then(() => {
      const row = list.get(id);
      if (row && (!row.hidden || ("joined" in row && !row.joined))) return;
      void sidebar.actions
        .reopen(target)
        .catch((cause: unknown) => console.error("closed chat could not be reopened", cause));
    });
  }, [id, sidebar, target]);
}

export function useListReadPosition() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () => (list: ChatList, channel: string) =>
      listReadPosition(queryClient, workspaceId, list, channel),
    [queryClient, workspaceId],
  );
}

export function useRefreshSidebar({ throwOnError = false }: { throwOnError?: boolean } = {}) {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () =>
      sidebarRefreshQueue((lists) =>
        Promise.all(
          [...lists].map((list) =>
            queryClient.invalidateQueries(
              { queryKey: chatListQueryKey[list](workspaceId) },
              { throwOnError },
            ),
          ),
        ).then(() => undefined),
      ),
    [queryClient, workspaceId, throwOnError],
  );
}

export function useApplyChannelSignal() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const sidebar = useSidebar();
  const refresh = useRefreshSidebar();
  return useMemo(
    () => (signal: ChannelSignal) => {
      const stale = applyChannelSignalToLists(queryClient, workspaceId, sidebar, signal);
      if (stale.length > 0) void refresh(stale);
    },
    [queryClient, workspaceId, sidebar, refresh],
  );
}

export function useApplyConversationActivity() {
  const sidebar = useSidebar();
  const refresh = useRefreshSidebar();
  const viewerId = useViewerId();
  return useMemo(
    () => (event: ConversationActivityEvent, options?: { openConversationId?: string }) => {
      if (!applyConversationActivityToRow(sidebar, event, viewerId, options))
        void refresh([event.kind === "channel" ? "channels" : "dms"]);
    },
    [sidebar, refresh, viewerId],
  );
}

export function useApplyMarkedEvent() {
  const sidebar = useSidebar();
  return useMemo(
    () => (event: MarkedEventUnreadPayload, options: { openConversationId?: string }) =>
      applyMarkedEventToSidebar(sidebar, event, options),
    [sidebar],
  );
}

export function useClearSidebarTopLevelUnread() {
  const sidebar = useSidebar();
  return useMemo(
    () => (conversationId: string) => clearSidebarTopLevelUnread(sidebar, conversationId),
    [sidebar],
  );
}

export function useRefreshSidebarChannels() {
  const refresh = useRefreshSidebar();
  return useMemo(() => () => refresh(["channels"]), [refresh]);
}

export function useRefreshSidebarLists() {
  const refresh = useRefreshSidebar();
  return useMemo(() => () => refresh(["channels", "dms"]), [refresh]);
}

export function useSavesRetrying() {
  const { savesRetrying } = useSidebar();
  return useSyncExternalStore(savesRetrying.subscribe, savesRetrying.count, () => 0);
}

export function useSidebarActions() {
  return useSidebar().actions;
}

const EMPTY_ORDER: readonly string[] = [];

export function useChatSections() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const queryClient = useQueryClient();
  const query = useQuery(chatSectionsQuery(workspaceId));
  const orderQuery = chatSectionOrderQuery(workspaceId);
  const order = useQuery(orderQuery);
  const sidebar = useSidebar();
  const live = useLiveQuery({
    queryKey: ["chat-sections", workspaceId],
    query: (q) =>
      q
        .from({ section: sidebar.sections })
        .orderBy(({ section }) => section.sortOrder, "asc")
        .orderBy(({ section }) => section.id, "asc"),
  });
  return {
    sections: live.isReady ? live.data : (query.data?.sections ?? []),
    order: order.data?.order ?? EMPTY_ORDER,
    orderReady: chatSectionOrderReady({
      status: order.status,
      isInvalidated: queryClient.getQueryState(orderQuery.queryKey)?.isInvalidated ?? false,
    }),
    status: chatSectionsStatus(query),
    retry: () => Promise.all([query.refetch(), order.refetch()]),
  };
}
