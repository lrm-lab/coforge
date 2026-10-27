import { useMemo, useState } from "react";
import { unreadBoundary } from "./conversation-open-position";

/** Captures the unread divider's position once when a conversation or thread opens. */
export function useConversationOpenBoundary(
  messages: Parameters<typeof unreadBoundary>[0],
  readThroughSequence: number,
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
