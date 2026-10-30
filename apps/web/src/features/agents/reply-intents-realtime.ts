import { useEffect } from "react";

import {
  conversationRealtimeChannel,
  userConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";

import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { useReplyIntentStore } from "./reply-intents-context";

import {
  applyConversationChannelPublication,
  applyUserChannelPublication,
  type ReplyIntentStore,
} from "./reply-intents";

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
  const [live] = useLiveAgentActivity();
  useEffect(() => {
    if (!live) replyIntents.clear();
  }, [live, replyIntents]);
  useRealtimeSubscription({
    channel: live && workspaceId && viewerId ? userConversationChannel(viewerId) : undefined,
    onSubscribed: () => replyIntents.clear(),
    onPublication: ({ data }) => {
      if (live && workspaceId) applyUserChannelPublication(replyIntents, data, workspaceId);
    },
  });
}

/** Only mounted conversation panes read typing; their message stream shares this lease. */
export function useConversationReplyIntents(
  workspaceId: string | undefined,
  conversationId: string,
) {
  const replyIntents = useReplyIntentStore();
  const [live] = useLiveAgentActivity();
  useEffect(() => {
    if (live && workspaceId && conversationId)
      return replyIntents.retainConversation(conversationId);
  }, [live, workspaceId, conversationId, replyIntents]);
  useRealtimeSubscription({
    channel:
      live && workspaceId && conversationId
        ? conversationRealtimeChannel(conversationId)
        : undefined,
    recoverable: true,
    positioned: true,
    onSubscribed: ({ wasRecovering }) => {
      // Typing is never replayed. A reconnect may have swallowed END; wait for the next START.
      // Joining an already-open subscription is not a gap for its existing readers.
      if (wasRecovering) replyIntents.clearConversation(conversationId);
    },
    onPublication: ({ data }) => {
      if (live && workspaceId)
        applyConversationChannelPublication(replyIntents, data, workspaceId, conversationId);
    },
  });
}
