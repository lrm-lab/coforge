import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ChatListValue } from "./chat-lists-reader";
import { channelNamesAfter, type ChannelSignal } from "./channel-signals";
import {
  channelNamesQueryKey,
  channelPageQueryKey,
  sidebarChannelsQueryKey,
} from "./conversation-query-keys";
import { countsOnRow, type ChatList } from "./conversation-unread";
import type { Sidebar } from "./sidebar-collections";
import type { ConversationActivityEvent } from "./conversation-activity-event";
import {
  applyActivityUnreadFields,
  applyMarkedUnreadFields,
  type MarkedEventUnreadPayload,
} from "./sidebar-unread-state";

type ChannelNamesRead = ChatListValue<"channelNames">;

/**
 * Applies a channel created, changed or gone anywhere in the Workspace to every channel's name and
 * to the channel list from the event alone, as Slack's clients apply `channel_created`, and returns
 * the lists still to re-read: one the event cannot place (an older server's ids-only event,
 * `#general` coming back, a sidebar not yet hydrated or synced), and one whose read was already
 * under way, whose older answer would otherwise land over the event.
 */
export function applyChannelSignalToLists(
  queryClient: QueryClient,
  workspaceId: string,
  sidebar: Sidebar | undefined,
  signal: ChannelSignal,
): ChatList[] {
  const namesKey = channelNamesQueryKey(workspaceId);
  const reading = (queryKey: QueryKey) => queryClient.isFetching({ queryKey }) > 0;
  const read = queryClient.getQueryData<ChannelNamesRead>(namesKey);
  const known = Boolean(read?.names.some((channel) => channel.id === signal.conversationId));
  const stale: ChatList[] = [];
  // Gone for the viewer (made private, hidden, deleted): its page, if open, reads again and,
  // refused, leaves for Chat. Made private, the channel's own event never reaches them: their
  // subscription to it ended first.
  if (signal.type === "channel.updated.v1" && signal.gone)
    void queryClient.invalidateQueries({
      queryKey: channelPageQueryKey(signal.conversationId),
      exact: true,
    });
  if (read) {
    const next = channelNamesAfter(read.names, signal);
    // The positions stay: only a server read changes them.
    if (next) queryClient.setQueryData<ChannelNamesRead>(namesKey, { ...read, names: next });
    if (!next || reading(namesKey)) stale.push("channelNames");
  }
  if (
    !sidebar?.applyChannelSignal(signal, { known }) ||
    reading(sidebarChannelsQueryKey(workspaceId))
  )
    stale.push("channels");
  return stale;
}

/**
 * Writes one message's `conversation.activity.v1` into the row it changes, with no read: the
 * channel row's last message (time, preview, sender) or the DM row's, from the same messages the
 * row counts (`countsOnRow`: a DM's thread replies, not a channel's). False when the list cannot
 * take it — not synced yet, a save is being retried (whose rollback would undo a direct write), or
 * the row is not in the list at all — and the caller re-reads that one list instead.
 */
export function applyConversationActivityToRow(
  sidebar: Sidebar | undefined,
  event: ConversationActivityEvent,
  viewerId: string | undefined,
  options?: { openConversationId?: string },
): boolean {
  if (event.kind === "channel" && !countsOnRow(event)) return true;
  if (!sidebar || sidebar.savesRetrying.count() > 0) return false;
  const id = event.conversationId;
  if (event.kind === "channel") {
    if (sidebar.channels.status !== "ready" || !sidebar.channels.has(id)) return false;
    const current = sidebar.channels.get(id);
    const isOwnMessage = viewerId !== undefined && event.senderUserId === viewerId;
    const mentioned = applyActivityUnreadFields(current?.mentioned === true, event, {
      isOpenChannel: options?.openConversationId === id,
      isOwnMessage,
    });
    sidebar.channels.utils.writeUpdate({
      id,
      mentioned,
      lastMessage: {
        createdAt: event.createdAt,
        preview: event.preview,
        ...(event.notice ? { notice: event.notice } : {}),
        ...(event.card ? { card: event.card } : {}),
        sender: {
          kind: event.sender.kind,
          name: event.sender.name,
          mine: isOwnMessage,
        },
      },
    });
    return true;
  }
  if (sidebar.directs.status !== "ready" || !sidebar.directs.has(id)) return false;
  sidebar.directs.utils.writeUpdate({
    conversationId: id,
    lastMessageAt: event.createdAt,
    lastMessagePreview: event.preview,
    lastMessageNotice: event.notice ?? null,
    lastMessageCard: event.card ?? null,
  });
  return true;
}

export function applyMarkedEventToSidebar(
  sidebar: Sidebar | undefined,
  event: MarkedEventUnreadPayload,
  options: { openConversationId?: string },
): void {
  if (!sidebar || sidebar.savesRetrying.count() > 0) return;
  const id = event.conversationId;
  const isOpen = options.openConversationId === id;
  if (event.type === "channel.marked.v1") {
    if (sidebar.channels.status !== "ready" || !sidebar.channels.has(id)) return;
    const next = applyMarkedUnreadFields(event, { isOpenChannel: isOpen });
    sidebar.channels.utils.writeUpdate({ id, ...next });
    return;
  }
  if (sidebar.directs.status !== "ready" || !sidebar.directs.has(id)) return;
  sidebar.directs.utils.writeUpdate({
    conversationId: id,
    unreadCount: isOpen ? 0 : event.unreadCount,
    markedUnread: isOpen ? false : event.markedUnread === true,
  });
}

export function clearSidebarTopLevelUnread(
  sidebar: Sidebar | undefined,
  conversationId: string,
): void {
  if (!sidebar || sidebar.savesRetrying.count() > 0) return;
  const clearChannel = () => {
    if (sidebar.savesRetrying.count() > 0 || !sidebar.channels.has(conversationId)) return false;
    const current = sidebar.channels.get(conversationId);
    if (current?.mentioned || current?.markedUnread || (current?.unreadCount ?? 0) > 0) {
      sidebar.channels.utils.writeUpdate({
        id: conversationId,
        unreadCount: 0,
        mentioned: false,
        markedUnread: false,
      });
    }
    return true;
  };
  const clearDirect = () => {
    if (sidebar.savesRetrying.count() > 0 || !sidebar.directs.has(conversationId)) return false;
    const current = sidebar.directs.get(conversationId);
    if (current?.markedUnread || (current?.unreadCount ?? 0) > 0) {
      sidebar.directs.utils.writeUpdate({
        conversationId,
        unreadCount: 0,
        markedUnread: false,
      });
    }
    return true;
  };
  if (sidebar.channels.status === "ready" && clearChannel()) return;
  if (sidebar.directs.status === "ready" && clearDirect()) return;
  if (sidebar.channels.status !== "ready") {
    void sidebar.channels.stateWhenReady().then(() => {
      clearChannel();
    });
  }
  if (sidebar.directs.status !== "ready") {
    void sidebar.directs.stateWhenReady().then(() => {
      clearDirect();
    });
  }
}
