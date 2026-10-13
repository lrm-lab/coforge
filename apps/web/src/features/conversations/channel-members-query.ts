import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { loadPublicChannelMembers } from "./channels.functions";
import { channelMembersQueryKey } from "./conversation-query-keys";

export type ChannelMembers = Awaited<ReturnType<typeof loadPublicChannelMembers>>;

/** The members roster every members surface reads: the channel header's face stack, the settings
 * panel's page and strip, and the action card's add dialog share one query per channel, so a
 * write there shows up here. */
export function useChannelMembers(channelId: string) {
  const load = useServerFn(loadPublicChannelMembers);
  return useQuery({
    queryKey: channelMembersQueryKey(channelId),
    queryFn: () => load({ data: { channelId } }),
    refetchOnWindowFocus: true,
  });
}
