import { useCallback, useEffect, useRef } from "react";

import {
  decodeActivityChangedEvent,
  decodeViewerEvent,
  userConversationChannel,
  type ActivityAttention,
} from "#src/features/conversations/conversation-realtime";
import {
  decodeConversationActivityEvent,
  type ConversationActivityEvent,
} from "#src/features/conversations/conversation-activity-event";
import {
  useRealtimeSubscription,
  type RealtimePublication,
} from "#src/features/realtime/browser-realtime";
import type { StreamPosition, SubscribedRecovery } from "#src/features/realtime/subscription-gap";

/** A burst of messages (an Agent posting several in a row) refreshes the listener once. */
const REFRESH_DELAY_MS = 300;

/**
 * Listens to the viewer's own conversation channel and calls `onMessage` for every message that
 * concerns them (`conversation.activity.v1`, already filtered to the people who may read it), and
 * `onActivity` once per burst for anything else that reached their Activity inbox and, with
 * `refreshOnPins`, for a pin change. The nav rail's Activity dot sets itself from `onMessage`
 * without a read, and from `onAttention` when a change says where the inbox stands; the Activity
 * page re-reads its first page from it.
 */
export function useActivityInboxRealtime({
  userId,
  onMessage,
  onActivity,
  onAttention,
  onSubscribed,
  refreshOnPins = false,
}: {
  userId: string;
  /** One message the viewer may read: not their own, not a system notice; `position` is where
   * it stands in the viewer's channel. */
  onMessage?: (event: ConversationActivityEvent, position: StreamPosition | undefined) => void;
  onActivity: () => void;
  /** Where the inbox stands after a clearing write (`ActivityAttention`), at once and in place of
   * `onActivity`. */
  onAttention?: (attention: ActivityAttention) => void;
  /** The channel became `subscribed`, and may have missed what was published before (see
   * `queryMissedBySubscribe`). */
  onSubscribed?: (recovery: SubscribedRecovery) => void;
  refreshOnPins?: boolean;
}) {
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  const onAttentionRef = useRef(onAttention);
  useEffect(() => {
    onAttentionRef.current = onAttention;
  }, [onAttention]);
  const onSubscribedRef = useRef(onSubscribed);
  useEffect(() => {
    onSubscribedRef.current = onSubscribed;
  }, [onSubscribed]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPublication = useCallback(
    (publication: RealtimePublication) => {
      const message = decodeConversationActivityEvent(publication.data);
      if (message) {
        // The server already sent it only to the people it concerns; the page still ignores its
        // own message and a system notice, exactly as the badge does.
        if (message.sender.kind !== "system" && message.senderUserId !== userId)
          onMessageRef.current?.(message, publication.position);
        return;
      }
      let attention: ActivityAttention | undefined;
      try {
        ({ attention } = decodeActivityChangedEvent(publication.data));
      } catch {
        // Neither a message nor an Activity signal (the channels also carry other events): only a
        // pin change the caller asked for refreshes.
        if (!refreshOnPins) return;
        const event = decodeViewerEvent(publication.data);
        if (event?.type !== "pref.changed.v1" || event.name !== "pins") return;
      }
      if (attention && onAttentionRef.current) return onAttentionRef.current(attention);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => onActivityRef.current(), REFRESH_DELAY_MS);
    },
    [refreshOnPins, userId],
  );

  useRealtimeSubscription({
    channel: userConversationChannel(userId),
    onPublication,
    onSubscribed: (recovery) => onSubscribedRef.current?.(recovery),
  });
}
