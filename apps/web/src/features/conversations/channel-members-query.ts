import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { channelMembersQuery } from "./channel-page-reads";
import { loadPublicChannelMembers } from "./channels.functions";

export type ChannelMembers = Awaited<ReturnType<typeof loadPublicChannelMembers>>;

/** One row of the roster: a human or an Agent, tagged with which. */
export type RosterMember = { kind: "user" | "agent" } & (
  | ChannelMembers["humans"][number]
  | ChannelMembers["agents"][number]
);

/** The members roster every members surface reads: the channel header's face stack, the settings
 * panel's page and strip, and the action card's add dialog share one query per channel, so a
 * write there shows up here. The channel page's loader reads it first (`prefetchChannelPageReads`). */
export function useChannelMembers(channelId: string) {
  const load = useServerFn(loadPublicChannelMembers);
  return useQuery({
    ...channelMembersQuery(channelId),
    queryFn: () => load({ data: { channelId } }),
  });
}
