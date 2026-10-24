import { useCallback } from "react";

import { agentPostsAmong, type ArrivedMessage } from "./reply-intents";
import { useReplyIntentStore } from "./reply-intents-context";

/**
 * Where a conversation's messages arrive (realtime and the catch-up reads after it), each Agent
 * message there ends what that Agent announced in its place (`agentPosted`), whichever view shows
 * that place and whether it is shown at all.
 */
export function useEndReplyIntentsOnArrival() {
  const intents = useReplyIntentStore();
  return useCallback(
    (conversationId: string, messages: readonly ArrivedMessage[]) => {
      for (const post of agentPostsAmong(conversationId, messages)) intents.agentPosted(post);
    },
    [intents],
  );
}
