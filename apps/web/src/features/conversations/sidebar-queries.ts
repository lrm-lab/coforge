import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import {
  listPublicChannels,
  setPublicChannelMuted,
  setPublicConversationPinned,
} from "./channels.functions";
import {
  setPublicConversationHidden,
  setPublicConversationUnread,
} from "./channel-sidebar-actions.functions";
import {
  loadDirectConversationBadges,
  loadDirectConversationPreferences,
  setDirectConversationHidden,
  setDirectConversationMuted,
  setDirectConversationPinned,
  setDirectConversationUnread,
} from "./conversations.functions";
import { arrangePinnedConversations } from "./conversation-pins.functions";
import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "./conversation-query-keys";
import type { PinRef } from "./pinned-conversations";
import { directRowsOf } from "./sidebar-rows";
import type { ChatList } from "./conversation-unread";
import { serverChatSectionsApi, type ChatSectionsApi } from "./chat-sections";
import { savedMessagesQueryKey } from "./saved-messages-collection";
import {
  olderStreamPositions,
  type StreamPosition,
  type StreamPositions,
} from "#src/features/realtime/subscription-gap";

/**
 * The Chat sidebar's two lists as Query reads: the server calls behind them, the query options the
 * page's loader fills, how fresh a cached list may be, and where a list stands in a signal
 * channel's stream. `sidebar-collections.ts` builds the collections over these same keys.
 */

type ChannelList = Awaited<ReturnType<typeof listPublicChannels>>;
/** What one read of every channel's name holds: the names and the stream position they stand at. */
type DirectPreferences = Awaited<ReturnType<typeof loadDirectConversationPreferences>>;
type DirectBadges = Awaited<ReturnType<typeof loadDirectConversationBadges>>;
export type Arrangement = { pins: readonly PinRef[]; unpinned: readonly PinRef[] };

/** The server calls the sidebar makes; tests pass their own. */
export type SidebarApi = {
  sections: ChatSectionsApi;
  listChannels: () => Promise<ChannelList>;
  loadDirectPreferences: () => Promise<DirectPreferences>;
  loadDirectBadges: () => Promise<DirectBadges>;
  pin: (target: PinRef, pinned: boolean) => Promise<unknown>;
  setMuted: (target: PinRef, muted: boolean) => Promise<unknown>;
  markUnread: (target: PinRef) => Promise<unknown>;
  close: (target: PinRef) => Promise<unknown>;
  arrange: (arrangement: Arrangement) => Promise<unknown>;
};

export const serverSidebarApi: SidebarApi = {
  sections: serverChatSectionsApi,
  listChannels: () => listPublicChannels(),
  loadDirectPreferences: () => loadDirectConversationPreferences(),
  loadDirectBadges: () => loadDirectConversationBadges(),
  pin: (target, pinned) =>
    target.kind === "channel"
      ? setPublicConversationPinned({ data: { channelId: target.channelId, pinned } })
      : setDirectConversationPinned({ data: { conversationId: target.conversationId, pinned } }),
  setMuted: (target, muted) =>
    target.kind === "channel"
      ? setPublicChannelMuted({ data: { channelId: target.channelId, muted } })
      : setDirectConversationMuted({ data: { conversationId: target.conversationId, muted } }),
  markUnread: (target) =>
    target.kind === "channel"
      ? setPublicConversationUnread({ data: { channelId: target.channelId, unread: true } })
      : setDirectConversationUnread({
          data: { conversationId: target.conversationId, unread: true },
        }),
  close: (target) =>
    target.kind === "channel"
      ? setPublicConversationHidden({ data: { channelId: target.channelId, hidden: true } })
      : setDirectConversationHidden({
          data: { conversationId: target.conversationId, hidden: true },
        }),
  arrange: (arrangement) =>
    arrangePinnedConversations({
      data: { pins: [...arrangement.pins], unpinned: [...arrangement.unpinned] },
    }),
};

/**
 * The channel list (shown in `compareChannelNames` order, the server's), when it was read, and the
 * signal channels' stream positions it was read at (`readAfterStreamPositions`): a direct write to
 * the cache keeps `fetchedAt` and the positions, so only a server read changes them.
 */
export function fetchChannels(api: SidebarApi) {
  return async () => {
    const { streamPositions, channels } = await api.listChannels();
    return { fetchedAt: Date.now(), rows: channels, streamPositions };
  };
}

export type ChannelRow = Awaited<ReturnType<ReturnType<typeof fetchChannels>>>["rows"][number];

/**
 * The DM rows, the viewer's id, and the stream positions the list stands at: per signal channel the
 * older of its two reads' (`olderStreamPositions`), since it may lack what either did. A re-read
 * fails as a whole, so the list keeps the rows it has; only a first load (`tolerant`) falls back per
 * read, as the page always has: rows without pins or badges, no viewer id (so no personal signal
 * channel keyed by an empty id), and no positions.
 */
export function fetchDirects(api: SidebarApi, { tolerant }: { tolerant: boolean }) {
  return async () => {
    let partial = false;
    const fallBack =
      <T>(fallback: T) =>
      () => {
        partial = true;
        return fallback;
      };
    const [preferences, badges] = await Promise.all([
      tolerant
        ? api
            .loadDirectPreferences()
            .catch(fallBack({ conversations: [], pinned: [], hidden: [], streamPositions: {} }))
        : api.loadDirectPreferences(),
      tolerant
        ? api.loadDirectBadges().catch(fallBack({ viewerId: "", unread: {}, streamPositions: {} }))
        : api.loadDirectBadges(),
    ]);
    return {
      fetchedAt: Date.now(),
      viewerId: badges.viewerId || undefined,
      rows: directRowsOf(preferences, badges.unread),
      streamPositions: olderStreamPositions(preferences.streamPositions, badges.streamPositions),
      /** A read fell back: the list is read again on the next navigation. */
      partial,
    };
  };
}

// The lists follow the member's own changes and realtime; a returning tab does not re-read them.
export const LIST_OPTIONS = { refetchOnWindowFocus: false } as const;

export const sidebarChannelsQuery = (workspaceId: string, api: SidebarApi = serverSidebarApi) =>
  queryOptions({
    queryKey: sidebarChannelsQueryKey(workspaceId),
    queryFn: fetchChannels(api),
    ...LIST_OPTIONS,
  });

/** The DM rows. `tolerant` only for a first load, when there are no rows yet to keep. */
export const sidebarDirectsQuery = (
  workspaceId: string,
  { tolerant = false, api = serverSidebarApi }: { tolerant?: boolean; api?: SidebarApi } = {},
) =>
  queryOptions({
    queryKey: sidebarDirectsQueryKey(workspaceId),
    queryFn: fetchDirects(api, { tolerant }),
    ...LIST_OPTIONS,
  });

/**
 * How fresh a Chat list the layout's loader reads must be: a hover preload reuses whatever is
 * cached; any other load reads only a list not cached or marked stale, since the page keeps the
 * lists live through realtime and re-reads them when a subscribe may have missed something
 * (`listsMissedBySubscribe`).
 */
export function chatListStaleTime(cause: "preload" | "enter" | "stay") {
  return cause === "preload" ? ("static" as const) : Infinity;
}

/**
 * The chat layout's read of the sidebar's two lists into the Query cache, which the sidebar reads
 * until its collections are ready (see `chatListStaleTime`). A first load has no DM rows to keep, so
 * each of its reads falls back on its own; a later one that fails keeps the rows the sidebar has.
 */
export async function loadSidebarLists(
  queryClient: QueryClient,
  workspaceId: string,
  cause: "preload" | "enter" | "stay",
  api: SidebarApi = serverSidebarApi,
) {
  const staleTime = chatListStaleTime(cause);
  const firstLoad = queryClient.getQueryData(sidebarDirectsQueryKey(workspaceId)) === undefined;
  const directs = queryClient.query({
    ...sidebarDirectsQuery(workspaceId, { tolerant: firstLoad, api }),
    staleTime,
  });
  await Promise.all([
    queryClient.query({ ...sidebarChannelsQuery(workspaceId, api), staleTime }),
    firstLoad ? directs : directs.catch(() => undefined),
  ]);
  const directsKey = sidebarDirectsQueryKey(workspaceId);
  if (queryClient.getQueryData<{ partial: boolean }>(directsKey)?.partial)
    await queryClient.invalidateQueries({ queryKey: directsKey, refetchType: "none" });
}

/**
 * Whether every channel's name (`channelNamesQuery`) is behind the channel list just read: a listed
 * channel it lacks, or one renamed since. The names cover closed and archived channels too, so a
 * shorter list is not behind. A page that was away from Chat misses the channel signals, so the
 * chat loader re-reads the names when this says so.
 */
export function channelNamesBehind(
  names: readonly { id: string; name: string }[],
  channels: readonly { id: string; name: string }[],
): boolean {
  const byId = new Map(names.map((channel) => [channel.id, channel.name]));
  return channels.some((channel) => byId.get(channel.id) !== channel.name);
}

/** The Query each Chat list is read into. Every one's data carries `streamPositions`, where its
 * last server read stood in the signal channels that keep it live (`readAfterStreamPositions`). */
export const chatListQueryKey: Record<ChatList, (workspaceId: string) => readonly unknown[]> = {
  channels: sidebarChannelsQueryKey,
  dms: sidebarDirectsQueryKey,
  channelNames: channelNamesQueryKey,
  saved: savedMessagesQueryKey,
};

/** Resolves once no read of `queryKey` is under way. */
function readSettled(queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  const reading = () => queryClient.isFetching({ queryKey }) > 0;
  if (!reading()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (reading()) return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Where a list's last server read stands in a signal channel's stream, for
 * `rereadMissedBySubscribe`; undefined when the read had no position for that channel (Centrifugo
 * unavailable, a stream reset between the reads of a DM list, a fallen-back first load), which
 * means the list is re-read. A read under way settles first, so a subscribe that lands
 * during the chat loader's read, or during the refetch of a stored copy, is judged by that read
 * instead of re-reading over it.
 */
export async function listReadPosition(
  queryClient: QueryClient,
  workspaceId: string,
  list: ChatList,
  channel: string,
): Promise<StreamPosition | undefined> {
  const queryKey = chatListQueryKey[list](workspaceId);
  await readSettled(queryClient, queryKey);
  return queryClient.getQueryData<{ streamPositions?: StreamPositions }>(queryKey)
    ?.streamPositions?.[channel];
}
