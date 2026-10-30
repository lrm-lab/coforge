import { useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  decodeActivityChangedEvent,
  decodeViewerEvent,
  userConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import {
  decodeConversationActivityEvent,
  type ConversationActivityEvent,
} from "#src/features/conversations/conversation-activity-event";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import type { SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import { getUserConversationSubscriptionToken } from "#src/features/realtime/realtime.functions";

/** A burst of messages (an Agent posting several in a row) refreshes the listener once. */
const REFRESH_DELAY_MS = 300;

/**
 * Listens to the viewer's own conversation channel and calls `onMessage` for every message that
 * concerns them (`conversation.activity.v1`, already filtered to the people who may read it), and
 * `onActivity` once per burst for anything else that reached their Activity inbox and, with
 * `refreshOnPins`, for a pin change. The nav rail's Activity dot sets itself from `onMessage`
 * without a read; the Activity page re-reads its first page from it.
 */
export function useActivityInboxRealtime({
  userId,
  onMessage,
  onActivity,
  onSubscribed,
  refreshOnPins = false,
}: {
  userId: string;
  /** One message the viewer may read: not their own, not a system notice. */
  onMessage?: (event: ConversationActivityEvent) => void;
  onActivity: () => void;
  /** The channel became `subscribed`, and may have missed what was published before (see
   * `queryMissedBySubscribe`). */
  onSubscribed?: (recovery: SubscribedRecovery) => void;
  refreshOnPins?: boolean;
}) {
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  const onSubscribedRef = useRef(onSubscribed);
  useEffect(() => {
    onSubscribedRef.current = onSubscribed;
  }, [onSubscribed]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      const message = decodeConversationActivityEvent(publication.data);
      if (message) {
        // The server already sent it only to the people it concerns; the page still ignores its
        // own message and a system notice, exactly as the badge does.
        if (message.sender.kind !== "system" && message.senderUserId !== userId)
          onMessageRef.current?.(message);
        return;
      }
      try {
        decodeActivityChangedEvent(publication.data);
      } catch {
        // Neither a message nor an Activity signal (the channels also carry other events): only a
        // pin change the caller asked for refreshes.
        if (!refreshOnPins) return;
        const event = decodeViewerEvent(publication.data);
        if (event?.type !== "pref.changed.v1" || event.name !== "pins") return;
      }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => onActivityRef.current(), REFRESH_DELAY_MS);
    },
    [refreshOnPins, userId],
  );

  useRealtimeSubscription({
    channel: userConversationChannel(userId),
    getToken: getUserToken,
    onPublication,
    onSubscribed: (recovery) => onSubscribedRef.current?.(recovery),
  });
}
