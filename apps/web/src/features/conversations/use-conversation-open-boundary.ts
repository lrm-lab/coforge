import { useMemo, useState } from "react";
import { unreadBoundary } from "./conversation-open-position";

/**
 * Captures the unread divider's position once when a conversation or thread opens. The divider
 * stays frozen while the mark-read effect advances the server cursor, and useState's initializer
 * avoids a render-phase ref write surviving a discarded React render.
 */
export function useConversationOpenBoundary(
  messages: Parameters<typeof unreadBoundary>[0],
  readThroughSequence: number | undefined,
  conversationId: string,
  rootId?: string,
) {
  const firstUnread = useMemo(
    () => unreadBoundary(messages, readThroughSequence),
    [conversationId, rootId],
  );
  const [openBoundary] = useState(firstUnread);
  return { firstUnread, openBoundary };
}
