import { useQuery } from "@tanstack/react-query";

import { loadPublicChannelMentionables } from "./channels.functions";
import type { Mentionable } from "./mention-text";

/**
 * A channel's member directory, as the composer's @-completion and a body's plain `@handle`s read
 * it. It starts from the page payload's copy (no second load on mount) and is
 * refetched when a membership write pushes `member.changed.v1`, when the subscription could not
 * replay what it missed — including the first subscribe, which covers changes made while the page
 * loaded (see `useConversationQuery`) — and when the tab regains focus. Every reader shares the
 * one Query, so that invalidation reaches them all.
 */
export function useChannelMentionables(
  channelId: string,
  payload: Mentionable[] | undefined,
): Mentionable[] | undefined {
  return useQuery({
    queryKey: ["conversation", "mentionables", channelId],
    queryFn: (): Promise<Mentionable[]> => loadPublicChannelMentionables({ data: { channelId } }),
    initialData: payload,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  }).data;
}
