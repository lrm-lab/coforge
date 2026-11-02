import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { loadPublicChannelMembers, loadPublicChannelMentionOutsiders } from "./channels.functions";
import { channelMembersQueryKey } from "./conversation-query-keys";
import type { Mentionable } from "./mention-text";

/** The members roster every members surface reads (`useChannelMembers`). Fresh for the app's
 * default 30 s (`router.tsx`), so the header mounting just after the loader's read takes it. */
export const channelMembersQuery = (channelId: string) =>
  queryOptions({
    queryKey: channelMembersQueryKey(channelId),
    queryFn: () => loadPublicChannelMembers({ data: { channelId } }),
    refetchOnWindowFocus: true,
  });

/** Who else the viewer may mention on purpose: the composer's group of the Workspace's people and
 * public Agents outside the channel. Its key shares the @-directory's prefix, so whatever refetches
 * the directory (`member.changed.v1`, a resubscribe that lost publications) refetches it too. */
export const channelMentionOutsidersQuery = (channelId: string) =>
  queryOptions({
    queryKey: ["conversation", "mentionables", channelId, "outsiders"],
    queryFn: (): Promise<Mentionable[]> =>
      loadPublicChannelMentionOutsiders({ data: { channelId } }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

type ChannelPageFacts = { senderMemberId?: string; archived?: boolean };

/** Whether the channel's page reads the outsiders: only a member of an open channel has a
 * composer to mention them from. */
export const readsMentionOutsiders = (page: ChannelPageFacts | undefined) =>
  Boolean(page?.senderMemberId) && page?.archived !== true;

/**
 * Starts a channel page's own reads beside its window, instead of after the page that shows them
 * has rendered, which costs a round trip more on every open (task #427): the roster at once, the
 * outsiders once the window says the viewer has a composer. Each is still its own server function
 * with its own access check. A failed read is left to the component that shows it, which reads
 * again when it mounts.
 */
export function prefetchChannelPageReads(
  queryClient: QueryClient,
  channelId: string,
  window: Promise<{ pages: ChannelPageFacts[] } | undefined>,
): void {
  void queryClient.prefetchQuery(channelMembersQuery(channelId));
  void window
    .then((opened) => {
      if (readsMentionOutsiders(opened?.pages.at(-1)))
        return queryClient.prefetchQuery(channelMentionOutsidersQuery(channelId));
    })
    .catch(() => undefined);
}
