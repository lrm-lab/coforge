import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { listChannelNames } from "./channels.functions";
import { channelNamesAfter, type ChannelSignal } from "./channel-signals";
import { channelNamesQueryKey, sidebarChannelsQueryKey } from "./conversation-query-keys";
import type { ChatList } from "./conversation-unread";
import type { Sidebar } from "./sidebar-collections";

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
