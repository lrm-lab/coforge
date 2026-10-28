import { useCallback, useMemo, useState } from "react";

import type { ReadPositions } from "./conversation-pane-layout";
import type { ConversationReadEvent } from "./conversation-realtime";

/**
 * What a conversation's own messages read their ticks from (`ownMessageReadState`): how far the
 * other members have read, from the page and then live from `conversation.read.v1` (`onRead`), and
 * which own message is the newest.
 */
export function useReadTicks(
  page: {
    conversationId: string;
    senderMemberId?: string;
    othersReadThroughSequence?: number;
    hasNewer?: boolean;
  },
  messages: readonly OwnMessageCandidate[],
) {
  const { conversationId, senderMemberId } = page;
  // Other members' reads heard live since the page was read. Kept apart from the cached pages and
  // merged by max, so a refetch that raced a read event cannot take a tick back.
  const [liveOthersRead, setLiveOthersRead] = useState<{
    conversationId: string;
    sequence: number;
  }>();
  const onRead = useCallback(
    (event: ConversationReadEvent) => {
      if (event.memberId === senderMemberId) return;
      setLiveOthersRead((current) => {
        const heard = current?.conversationId === event.conversationId ? current.sequence : 0;
        return event.readThroughSequence > heard
          ? { conversationId: event.conversationId, sequence: event.readThroughSequence }
          : current;
      });
    },
    [senderMemberId],
  );
  const othersReadThroughSequence = Math.max(
    page.othersReadThroughSequence ?? 0,
    liveOthersRead?.conversationId === conversationId ? liveOthersRead.sequence : 0,
  );
  // The newest own message is only known while the window holds the live end.
  const latestOwnSequence = useMemo(
    () => (senderMemberId && !page.hasNewer ? latestOwn(messages, senderMemberId) : undefined),
    [messages, senderMemberId, page.hasNewer],
  );
  const readTicks = useMemo<ReadPositions>(
    () => ({ othersReadThroughSequence, latestOwnSequence }),
    [othersReadThroughSequence, latestOwnSequence],
  );
  return { readTicks, onRead };
}

type OwnMessageCandidate = {
  sequence: number;
  senderMemberId?: string | null;
  weeklyReportHidden?: boolean;
};

/** The newest message the viewer sent that the pane shows, scanning back from the live end. */
function latestOwn(messages: readonly OwnMessageCandidate[], senderMemberId: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.senderMemberId === senderMemberId && message.weeklyReportHidden !== true)
      return message.sequence;
  }
  return undefined;
}
