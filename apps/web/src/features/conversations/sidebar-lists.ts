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
import { applyChannelSignalToLists, applyConversationActivityToRow } from "./sidebar-signals";
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

// React access to the Chat sidebar's lists (`sidebar-collections.ts`).

const sidebarsByClient = new WeakMap<QueryClient, Map<string, Sidebar>>();

/** One sidebar (collections and actions) per `QueryClient` and Workspace, TanStack DB's
 * business-scope pattern: every consumer shares one sync, one optimistic state, one save queue. */
function sidebarFor(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = sidebarsByClient.get(queryClient);
  if (!byWorkspace) sidebarsByClient.set(queryClient, (byWorkspace = new Map()));
  let sidebar = byWorkspace.get(workspaceId);
  if (!sidebar) byWorkspace.set(workspaceId, (sidebar = createSidebar(queryClient, workspaceId)));
  return sidebar;
}

/** The sidebar: TanStack DB collections are client-only, and Chat is only rendered in the browser
 * (`createSidebar` fails on the server). */
function useSidebar() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return sidebarFor(queryClient, workspaceId);
}

/** A channel row as the lists hold it: without its last message, which moves on every message and
 * is read per row (`useLiveChannelRow`), so a message does not render the whole list. */
type ListedChannel = Omit<ChannelRow, "lastMessage">;

const NO_ROWS: readonly never[] = [];

/** The rows of the last server read of each list: what the lists show until their live queries are
 * ready (the first tick). */
function cachedChannelRows(queryClient: QueryClient, workspaceId: string): readonly ChannelRow[] {
  return queryClient.getQueryData(sidebarChannelsQuery(workspaceId).queryKey)?.rows ?? NO_ROWS;
}
function cachedDirectRows(queryClient: QueryClient, workspaceId: string): readonly DirectRow[] {
  return queryClient.getQueryData(sidebarDirectsQuery(workspaceId).queryKey)?.rows ?? NO_ROWS;
}

/**
 * The sidebar's lists: channels in the server's order (a closed one only while pinned), the DM rows
 * by conversation id, and when the server last sent them (`readAt`, which a saved change does not move).
 * Read from the Query cache the chat loader filled until the live queries are ready, then live
 * from the collections. The rows leave their last message out, so a message renders none of the
 * lists' readers.
 */
export function useSidebarLists() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const queryClient = useQueryClient();
  // Only a new server read re-renders from these: a row written straight into a list (a message's
  // last message, a pin) moves the cache's `dataUpdatedAt` but not its `fetchedAt`.
  const channelsReadAt = useSuspenseQuery({
    ...sidebarChannelsQuery(workspaceId),
    select: (read) => read.fetchedAt,
  }).data;
  const directsRead = useSuspenseQuery({
    ...sidebarDirectsQuery(workspaceId),
    select: ({ fetchedAt, viewerId }) => ({ fetchedAt, viewerId }),
  }).data;
  const sidebar = useSidebar();
  // A projection is told of a row's change only when what it selects changed.
  const liveChannels = useLiveQuery({
    queryKey: ["sidebar-channels", workspaceId],
    query: (q) =>
      q.from({ row: sidebar.channels }).select(({ row }) => ({ ...row, lastMessage: null })),
  });
  const liveDirects = useLiveQuery({
    queryKey: ["sidebar-directs", workspaceId],
    query: (q) =>
      q
        .from({ row: sidebar.directs })
        .select(({ row }) => ({ ...row, lastMessageAt: null, lastMessagePreview: null })),
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

/** The viewer's id, as the DM list's last server read gave it. */
function useViewerId() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useSuspenseQuery({
    ...sidebarDirectsQuery(workspaceId),
    select: (read) => read.viewerId,
  }).data;
}

type RowSource<Row> = ChangingRows & { isReady(): boolean; get(key: string): Row | undefined };

/** One row of a sidebar collection, rendering its reader only when that row changes; from the
 * last server read until the collection is ready. */
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

/** One channel's row with its last message: the row alone renders when a message arrives. */
export function useLiveChannelRow(channelId: string): ChannelRow | undefined {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const cached = cachedChannelRows(queryClient, workspaceId);
  return useLiveRow(useSidebar().channels, channelId, cached, (row) => row.id);
}

/** One DM's row with its last message: the row alone renders when a message arrives. */
export function useLiveDirectRow(conversationId: string): DirectRow | undefined {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const cached = cachedDirectRows(queryClient, workspaceId);
  return useLiveRow(useSidebar().directs, conversationId, cached, (row) => row.conversationId);
}

/**
 * When each of `ids` last had a message, for the sections sorted by Recent: the one read of the
 * lists that moves with every message, so it reads those rows' times alone, and nothing when no
 * section sorts that way.
 */
export function useLastMessageTimes(ids: readonly string[]): ReadonlyMap<string, string | null> {
  const sidebar = useSidebar();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const wanted = [...new Set(ids)].sort();
  const key = wanted.join(",");
  const channels = useLiveQuery({
    queryKey: ["sidebar-channel-times", workspaceId, key],
    query: (q) =>
      wanted.length === 0
        ? undefined
        : q
            .from({ row: sidebar.channels })
            .where(({ row }) => inArray(row.id, wanted))
            .select(({ row }) => ({ id: row.id, at: row.lastMessage?.createdAt })),
  });
  const directs = useLiveQuery({
    queryKey: ["sidebar-direct-times", workspaceId, key],
    query: (q) =>
      wanted.length === 0
        ? undefined
        : q
            .from({ row: sidebar.directs })
            .where(({ row }) => inArray(row.conversationId, wanted))
            .select(({ row }) => ({ id: row.conversationId, at: row.lastMessageAt })),
  });
  return useMemo(() => {
    // Until a live query is ready (the first tick) the last server read holds the same times; the
    // layout looks up only the ids it asked for.
    const channelTimes = channels.isReady
      ? (channels.data ?? NO_ROWS)
      : cachedChannelRows(queryClient, workspaceId).map((row) => ({
          id: row.id,
          at: row.lastMessage?.createdAt,
        }));
    const directTimes = directs.isReady
      ? (directs.data ?? NO_ROWS)
      : cachedDirectRows(queryClient, workspaceId).map((row) => ({
          id: row.conversationId,
          at: row.lastMessageAt,
        }));
    return new Map([...channelTimes, ...directTimes].map((row) => [row.id, row.at ?? null]));
  }, [channels.isReady, channels.data, directs.isReady, directs.data, queryClient, workspaceId]);
}

/** The chat each sidebar last saw opened: a page that mounts again for it (a loader's pending
 * state, a hosted pane's suspense) is not a new opening. */
const lastOpened = new WeakMap<object, string>();

/**
 * A closed chat comes back to the list when the viewer opens it, whichever way they came (Slack):
 * once per opening, so closing the open chat still closes it. Unless the list shows it open (or
 * as a channel they are not in), the server is asked, as a closed channel is not in the list at
 * all; for a chat that was not closed it changes nothing and tells no one. The viewer's other
 * pages hear of a reopening as of any.
 */
export function useReopenClosedOnOpen(target: PinRef) {
  const sidebar = useSidebar();
  const id = target.kind === "channel" ? target.channelId : target.conversationId;
  useEffect(() => {
    if (lastOpened.get(sidebar) === id) return;
    lastOpened.set(sidebar, id);
    const list = target.kind === "channel" ? sidebar.channels : sidebar.directs;
    // Decided on the synced list, so a chat opened before it arrives is not taken for a closed one.
    void list.stateWhenReady().then(() => {
      const row = list.get(id);
      // Listed and open, or a channel they are not in: nothing to bring back.
      if (row && (!row.hidden || ("joined" in row && !row.joined))) return;
      // A failed reopening leaves the open chat out of the list: say so where it can be traced.
      void sidebar.actions
        .reopen(target)
        .catch((cause: unknown) => console.error("closed chat could not be reopened", cause));
    });
  }, [id, sidebar, target]);
}

/**
 * Where each Chat list's last server read stands in a signal channel's stream, for
 * `rereadMissedBySubscribe` (`listReadPosition`).
 */
export function useListReadPosition() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () => (list: ChatList, channel: string) =>
      listReadPosition(queryClient, workspaceId, list, channel),
    [queryClient, workspaceId],
  );
}

/**
 * Re-reads the named lists, and only them, after something outside the sidebar changed them: a
 * channel's creation, rename, description or archive here (another page's arrives as a channel
 * signal, `useApplyChannelSignal`), a message that brings a closed or unlisted chat in, the
 * Activity page moving badges, or the viewer's own place in a chat or their Saved list changed on
 * another page, tab or device (a `ViewerEvent`). A burst is read once (`sidebarRefreshQueue`). The collections follow the
 * refetched Query data. Mutation flows that keep an inline retry on failure opt in to
 * `throwOnError`; realtime refreshes retain the best-effort default.
 */
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

/** Applies a channel created, changed or gone anywhere in the Workspace to the lists
 * (`applyChannelSignalToLists`), re-reading only what the event could not settle. */
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

/** Writes one message's row into the sidebar from its `conversation.activity.v1`, with no read;
 * a row the list does not hold (a closed chat, a DM nobody has read yet) re-reads its own list. */
export function useApplyConversationActivity() {
  const sidebar = useSidebar();
  const refresh = useRefreshSidebar();
  const viewerId = useViewerId();
  return useMemo(
    () => (event: ConversationActivityEvent) => {
      if (!applyConversationActivityToRow(sidebar, event, viewerId))
        void refresh([event.kind === "channel" ? "channels" : "dms"]);
    },
    [sidebar, refresh, viewerId],
  );
}

/** Re-reads the channel list alone: a channel changed outside the sidebar (a rename, description or
 * archive here, or the viewer's own leave or mute from the settings panel). */
export function useRefreshSidebarChannels() {
  const refresh = useRefreshSidebar();
  return useMemo(() => () => refresh(["channels"]), [refresh]);
}

/** Re-reads both lists after a change made on another page moved their unread badges (the Activity
 * page reading or marking Done). */
export function useRefreshSidebarLists() {
  const refresh = useRefreshSidebar();
  return useMemo(() => () => refresh(["channels", "dms"]), [refresh]);
}

/** How many sidebar section changes are being saved again after a failed try. */
export function useSavesRetrying() {
  const { savesRetrying } = useSidebar();
  return useSyncExternalStore(savesRetrying.subscribe, savesRetrying.count, () => 0);
}

/** The sidebar's changes (pin, mark unread, close, drag). */
export function useSidebarActions() {
  return useSidebar().actions;
}

const EMPTY_ORDER: readonly string[] = [];

/** Personal groups share the sidebar's optimistic transactions, including a move's unpin. */
export function useChatSections() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const queryClient = useQueryClient();
  const query = useQuery(chatSectionsQuery(workspaceId));
  // The built-in sections' places; until it loads (or if it fails) they keep the default order.
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
    /** Sections may be dragged only once their saved order is read: a drag from the default
     * order, or from a restored copy, would overwrite it. */
    orderReady: chatSectionOrderReady({
      status: order.status,
      isInvalidated: queryClient.getQueryState(orderQuery.queryKey)?.isInvalidated ?? false,
    }),
    /** A failed order read is not reported: the sections keep the default order. */
    status: chatSectionsStatus(query),
    retry: () => Promise.all([query.refetch(), order.refetch()]),
  };
}
