import { useServerFn } from "@tanstack/react-start";

import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getUserConversationSubscriptionToken } from "#src/features/realtime/realtime.functions";

import { applyUserChannelPublication, type ReplyIntentStore } from "./reply-intents";

/**
 * The reply intents of a direct message with the viewer, which the server publishes to the
 * viewer's own channel (`chat:user:<id>`) instead of the Agent Activity channels, where every
 * Workspace member would see that the conversation exists. It joins the viewer's one shared
 * subscription to that channel, which carries other events too; a (re)subscribe empties the store,
 * since the gap may have swallowed an end.
 */
export function useUserChannelReplyIntents(
  workspaceId: string | undefined,
  viewerId: string | undefined,
  replyIntents: ReplyIntentStore,
) {
  const getToken = useServerFn(getUserConversationSubscriptionToken);
  useRealtimeSubscription({
    channel: workspaceId && viewerId ? userConversationChannel(viewerId) : undefined,
    getToken,
    onSubscribed: () => replyIntents.clear(),
    onPublication: ({ data }) => {
      if (workspaceId) applyUserChannelPublication(replyIntents, data, workspaceId);
    },
  });
}
