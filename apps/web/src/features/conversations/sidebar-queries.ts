import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import {
  setPublicChannelMuted,
  setPublicChannelNotificationLevel,
  setPublicConversationPinned,
} from "./channels.functions";
import type { ChannelNotificationLevel } from "./notification-levels";
import {
  markPublicConversationAllRead,
  setPublicConversationHidden,
  setPublicConversationUnread,
} from "./channel-sidebar-actions.functions";
import {
  markDirectConversationAllRead,
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
import { queryStreamPosition } from "#src/features/realtime/query-stream-position";
import {
  chatSectionOrderQuery,
  chatSectionsQuery,
  serverChatSectionsApi,
  type ChatSectionsApi,
} from "./chat-sections";
import { savedMessagesQueryKey } from "./saved-messages-collection";
import { olderStreamPositions, type StreamPosition } from "#src/features/realtime/subscription-gap";
import { readChatList, type ChatListValue } from "./chat-lists-reader";

type ChannelList = ChatListValue<"channels">;
export type ChannelRow = Omit<ChannelList["channels"][number], "firstUnreadMessageId"> & {
  firstUnreadMessageId?: string | null;
};
type DirectPreferences = ChatListValue<"directPreferences">;
type DirectBadges = ChatListValue<"directBadges">;
export type Arrangement = { pins: readonly PinRef[]; unpinned: readonly PinRef[] };

export type SidebarApi = {
  sections: ChatSectionsApi;
  listChannels: () => Promise<ChannelList>;
  loadDirectPreferences: () => Promise<DirectPreferences>;
  loadDirectBadges: () => Promise<DirectBadges>;
  pin: (target: PinRef, pinned: boolean) => Promise<unknown>;
  setMuted: (target: PinRef, muted: boolean) => Promise<unknown>;
  setNotificationLevel: (channelId: string, level: ChannelNotificationLevel) => Promise<unknown>;
  markUnread: (target: PinRef) => Promise<unknown>;
  markRead?: (target: PinRef) => Promise<unknown>;
  setHidden: (target: PinRef, hidden: boolean) => Promise<unknown>;
  arrange: (arrangement: Arrangement) => Promise<unknown>;
};

export const serverSidebarApi: SidebarApi = {
  sections: serverChatSectionsApi,
  listChannels: () => readChatList("channels"),
  loadDirectPreferences: () => readChatList("directPreferences"),
  loadDirectBadges: () => readChatList("directBadges"),
  pin: (target, pinned) =>
    target.kind === "channel"
      ? setPublicConversationPinned({ data: { channelId: target.channelId, pinned } })
      : setDirectConversationPinned({ data: { conversationId: target.conversationId, pinned } }),
  setMuted: (target, muted) =>
    target.kind === "channel"
      ? setPublicChannelMuted({ data: { channelId: target.channelId, muted } })
      : setDirectConversationMuted({ data: { conversationId: target.conversationId, muted } }),
  setNotificationLevel: (channelId, notificationLevel) =>
    setPublicChannelNotificationLevel({ data: { channelId, notificationLevel } }),
  markUnread: (target) =>
    target.kind === "channel"
      ? setPublicConversationUnread({ data: { channelId: target.channelId, unread: true } })
      : setDirectConversationUnread({
          data: { conversationId: target.conversationId, unread: true },
        }),
  markRead: (target) =>
    target.kind === "channel"
      ? markPublicConversationAllRead({ data: { channelId: target.channelId } })
      : markDirectConversationAllRead({ data: { conversationId: target.conversationId } }),
  setHidden: (target, hidden) =>
    target.kind === "channel"
      ? setPublicConversationHidden({ data: { channelId: target.channelId, hidden } })
      : setDirectConversationHidden({ data: { conversationId: target.conversationId, hidden } }),
  arrange: (arrangement) =>
    arrangePinnedConversations({
      data: { pins: [...arrangement.pins], unpinned: [...arrangement.unpinned] },
    }),
};

export function fetchChannels(api: SidebarApi) {
  return async () => {
    const { streamPositions, channels } = await api.listChannels();
    const rows: ChannelRow[] = channels;
    return { fetchedAt: Date.now(), rows, streamPositions };
  };
}

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
        ? api.loadDirectBadges().catch(
            fallBack({
              viewerId: "",
              unread: {},
              firstUnreadMessageIds: {},
              streamPositions: {},
            }),
          )
        : api.loadDirectBadges(),
    ]);
    return {
      fetchedAt: Date.now(),
      viewerId: badges.viewerId || undefined,
      rows: directRowsOf(preferences, badges.unread, badges.firstUnreadMessageIds),
      streamPositions: olderStreamPositions(preferences.streamPositions, badges.streamPositions),
      partial,
    };
  };
}

export const LIST_OPTIONS = { refetchOnWindowFocus: false } as const;

export const sidebarChannelsQuery = (workspaceId: string, api: SidebarApi = serverSidebarApi) =>
  queryOptions({
    queryKey: sidebarChannelsQueryKey(workspaceId),
    queryFn: fetchChannels(api),
    ...LIST_OPTIONS,
  });

export const sidebarDirectsQuery = (
  workspaceId: string,
  { tolerant = false, api = serverSidebarApi }: { tolerant?: boolean; api?: SidebarApi } = {},
) =>
  queryOptions({
    queryKey: sidebarDirectsQueryKey(workspaceId),
    queryFn: fetchDirects(api, { tolerant }),
    ...LIST_OPTIONS,
  });

export function chatListStaleTime(cause: "preload" | "enter" | "stay") {
  return cause === "preload" ? ("static" as const) : Infinity;
}

export async function loadSidebarLists(
  queryClient: QueryClient,
  workspaceId: string,
  cause: "preload" | "enter" | "stay",
  api: SidebarApi = serverSidebarApi,
) {
  const staleTime = chatListStaleTime(cause);
  void queryClient.prefetchQuery({ ...chatSectionsQuery(workspaceId, api.sections), staleTime });
  void queryClient.prefetchQuery({
    ...chatSectionOrderQuery(workspaceId, api.sections),
    staleTime,
  });
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

export function channelNamesBehind(
  names: readonly { id: string; name: string }[],
  channels: readonly { id: string; name: string }[],
): boolean {
  const byId = new Map(names.map((channel) => [channel.id, channel.name]));
  return channels.some((channel) => byId.get(channel.id) !== channel.name);
}

export const chatListQueryKey: Record<ChatList, (workspaceId: string) => readonly unknown[]> = {
  channels: sidebarChannelsQueryKey,
  dms: sidebarDirectsQueryKey,
  channelNames: channelNamesQueryKey,
  saved: savedMessagesQueryKey,
  sections: (workspaceId) => chatSectionsQuery(workspaceId).queryKey,
  sectionOrder: (workspaceId) => chatSectionOrderQuery(workspaceId).queryKey,
};

export async function listReadPosition(
  queryClient: QueryClient,
  workspaceId: string,
  list: ChatList,
  channel: string,
): Promise<StreamPosition | undefined> {
  return queryStreamPosition(queryClient, chatListQueryKey[list](workspaceId), channel);
}
