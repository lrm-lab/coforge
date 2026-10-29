import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { listChannelNames } from "./channels.functions";
import { channelNamesAfter, type ChannelSignal } from "./channel-signals";
import { channelNamesQueryKey, sidebarChannelsQueryKey } from "./conversation-query-keys";
import type { ChatList } from "./conversation-unread";
import type { Sidebar } from "./sidebar-collections";
import type { ConversationActivityEvent } from "./conversation-realtime";

type ChannelNamesRead = Awaited<ReturnType<typeof listChannelNames>>;

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
 * channel row's last message (time, preview, sender) or the DM row's. False when the list cannot
 * take it — not synced yet, a save is being retried (whose rollback would undo a direct write), or
 * the row is not in the list at all — and the caller re-reads that one list instead.
 */
export function applyConversationActivityToRow(
  sidebar: Sidebar | undefined,
  event: ConversationActivityEvent,
  viewerId: string | undefined,
): boolean {
  if (!sidebar || sidebar.savesRetrying.count() > 0) return false;
  const id = event.conversationId;
  if (event.kind === "channel") {
    if (sidebar.channels.status !== "ready" || !sidebar.channels.has(id)) return false;
    sidebar.channels.utils.writeUpdate({
      id,
      lastMessage: {
        createdAt: event.createdAt,
        preview: event.preview,
        sender: {
          kind: event.sender.kind,
          name: event.sender.name,
          mine: viewerId !== undefined && event.senderUserId === viewerId,
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
  });
  return true;
}
