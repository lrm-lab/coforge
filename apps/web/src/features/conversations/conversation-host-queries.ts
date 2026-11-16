import { queryOptions } from "@tanstack/react-query";

import { channelNamesQueryKey } from "./conversation-query-keys";
import { savedMessagesQueryKey } from "./saved-messages-collection";
import { readChatList, type ChatListValue } from "./chat-lists-reader";

/** The viewer's Saved list, the Query the Saved collection (`saved-messages-collection.ts`) syncs
 * from: a host's loader reads it into the cache, and the collection starts from what is there. Its
 * data is a whole read (`SavedList`): the entries, and the stream position it was read at. */
export const savedMessagesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: savedMessagesQueryKey(workspaceId),
    queryFn: () => readChatList("saved"),
  });

/** Every channel of the Workspace by id, closed ones included — what a body's channel links and
 * the composer's `#` list read, in Chat and on any page that shows a conversation (the Tasks page's
 * popup). Chat keeps it live: `channel.created.v1` and `channel.updated.v1` are written into it
 * (`useApplyChannelSignal`). The Query holds the whole read, the names beside the stream position
 * they were read at; a hook reading it gets the names. */
export const channelNamesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: channelNamesQueryKey(workspaceId),
    queryFn: () => readChatList("channelNames"),
    select: namesOfRead,
    staleTime: 60_000,
  });

function namesOfRead(read: ChatListValue<"channelNames">) {
  return read.names;
}
