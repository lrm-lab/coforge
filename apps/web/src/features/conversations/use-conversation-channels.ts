import { useMemo } from "react";

import { useConversationHostChannels } from "./conversation-host";
import type { DirectConversationView } from "./conversation-types";
import { makeReferenceBodyFormatter } from "./mention-text";
import type { ChannelSuggestion } from "./reference-completion";

/** No channels to link or suggest: one array, so what is memoized on the list keeps. */
const NO_CHANNELS: readonly ChannelSuggestion[] = [];

/**
 * The channels a conversation's references resolve against: the list it was handed, else the
 * hosting page's. A stored channel reference links to its channel, under its current name, only
 * when the Workspace has that channel: every channel by id, closed ones included. Also the
 * formatter preview rows spell a body with, so a reference never reads as its raw `<@kind:…>`
 * token there, resolved the way the message list does.
 */
export function useConversationChannels(
  channels: readonly ChannelSuggestion[] | undefined,
  mentionables: DirectConversationView["mentionables"],
) {
  const hostChannels = useConversationHostChannels();
  const channelList = channels ?? hostChannels ?? NO_CHANNELS;
  const channelNames = useMemo(
    () => new Map(channelList.map((channel) => [channel.id, channel.name])),
    [channelList],
  );
  const formatPreviewBody = useMemo(
    () => makeReferenceBodyFormatter(mentionables ?? [], channelNames),
    [mentionables, channelNames],
  );
  return { channelList, channelNames, formatPreviewBody };
}
