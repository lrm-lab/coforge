import { useRef, useState } from "react";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  conversationRealtimeChannel,
  decodeMessageAvailableEvent,
  type MessageAvailableEvent,
} from "./conversation-realtime";

type Pane = { conversationId: string; rootId: string | undefined; viewerId: string | undefined };

export function countsAsNewMessage(event: MessageAvailableEvent, pane: Pane): boolean {
  if (event.conversationId !== pane.conversationId) return false;
  if ((event.threadRootId ?? undefined) !== pane.rootId) return false;
  return pane.viewerId === undefined || event.senderUserId !== pane.viewerId;
}

function decodedMessage(data: unknown): MessageAvailableEvent | undefined {
  try {
    return decodeMessageAvailableEvent(data);
  } catch {
    return undefined;
  }
}

export function usePushedNewMessages(pane: Pane): number {
  const arrived = useRef(new Set<string>());
  const [count, setCount] = useState(0);
  useRealtimeSubscription({
    channel: pane.conversationId ? conversationRealtimeChannel(pane.conversationId) : undefined,
    recoverable: true,
    positioned: true,
    onPublication: ({ data }) => {
      const event = decodedMessage(data);
      if (!event || !countsAsNewMessage(event, pane) || arrived.current.has(event.messageId))
        return;
      arrived.current.add(event.messageId);
      setCount(arrived.current.size);
    },
  });
  return count;
}
