import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";

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
import { directListsOf, type DirectRow } from "./sidebar-rows";
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

/**
 * The sidebar's lists: channels in the server's order (a closed one only while pinned), the DM rows
 * by conversation id, and when the server last sent them (`readAt`, which a saved change does not move).
 * Read from the Query cache the chat loader filled until the live queries are ready, then live
 * from the collections.
 */
export function useSidebarLists() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Only a new read re-renders from these: once the live queries are ready the rows come from the
  // collections.
  const channelsCache = useSuspenseQuery({
    ...sidebarChannelsQuery(workspaceId),
    notifyOnChangeProps: ["dataUpdatedAt"],
  }).data;
  const directsCache = useSuspenseQuery({
    ...sidebarDirectsQuery(workspaceId),
    notifyOnChangeProps: ["dataUpdatedAt"],
  }).data;
  const sidebar = useSidebar();
  const liveChannels = useLiveQuery({
    queryKey: ["sidebar-channels", workspaceId],
    query: (q) => q.from({ row: sidebar.channels }),
  });
  const liveDirects = useLiveQuery({
    queryKey: ["sidebar-directs", workspaceId],
    query: (q) => q.from({ row: sidebar.directs }),
  });
  // Until a live query is ready (the first tick) the cache holds the same rows.
  const channelRows: readonly ChannelRow[] =
    (liveChannels.isReady && liveChannels.data) || channelsCache.rows;
  const directRows: readonly DirectRow[] =
    (liveDirects.isReady && liveDirects.data) || directsCache.rows;
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
    viewerId: directsCache.viewerId,
    readAt: { channels: channelsCache.fetchedAt, dms: directsCache.fetchedAt },
  };
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
  const { viewerId } = useSidebarLists();
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
