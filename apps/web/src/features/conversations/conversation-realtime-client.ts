import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  useBrowserRealtime,
  subscribeToSharedRealtime,
  type SharedRealtimeClient,
} from "#src/features/realtime/browser-realtime";
import { getConversationRealtimeToken } from "#src/features/realtime/realtime.functions";
import { queryStreamPosition } from "#src/features/realtime/query-stream-position";
import {
  missedBySubscribe,
  subscriptionGap,
  type StreamPosition,
  type StreamPositions,
  type SubscribedRecovery,
} from "#src/features/realtime/subscription-gap";
import {
  conversationRealtimeChannel,
  decodeChannelUpdatedEvent,
  decodeConversationReadEvent,
  decodeMemberChangedEvent,
  decodeMessageAvailableEvent,
  decodeMessageReactionEvent,
  type MessageReactionEvent,
  type ConversationReadEvent,
} from "./conversation-realtime";
import { deviceComposerOutbox } from "./use-message-outbox";

/** Which member lists a missed membership change may have stale-dated (see `onMemberChanged`). */
export type MemberDirectoryStale = "page-payload" | "all";

export function subscribeToConversationRealtime(
  client: SharedRealtimeClient,
  input: {
    conversationId: string;
    getToken: () => Promise<string>;
    /** Where the page's newest window was read in this conversation's stream, once a read of it
     * under way has settled; undefined when it has none. A first subscribe past nothing new since
     * reads nothing again (`streamMovedSince`). */
    readPosition?: () => Promise<StreamPosition | undefined>;
    /** Where the window stood in the stream when the page opened it: its member lists were read
     * from that copy or after it, so a first subscribe past nothing new since leaves them. */
    openedAt?: StreamPosition;
    /** A first subscribe found nothing new since the window was read: caught up without a read. */
    onCaughtUp?: () => void;
    /** `restart`: the page came back (visible, online, or a resubscribe that could not replay
     * what it missed), so a read in flight may be stuck on a connection that died meanwhile
     * (`createConversationReconciler`). */
    reconcile: (options?: { restart?: boolean }) => void;
    /** A membership change in this conversation (join/leave/add/remove) may have gone unseen:
     * the member directory (composer candidates, plain-@handle resolution) must be refetched.
     * `"page-payload"`: the first subscribe, which covers what changed while the page loaded, so
     * only the lists read before it (the page payload's) are stale; a list the browser first
     * read after hydration was read about as late as the subscribe. `"all"`: a
     * `member.changed.v1` publication, or a resubscribe that lost publications. */
    onMemberChanged?: (stale: MemberDirectoryStale) => void;
    /** This channel was renamed, described, archived or unarchived: the page's own copy of those
     * facts is stale and must be refetched. */
    onChannelUpdated?: () => void;
    /** A message the viewer sent from the browser now exists: its signal names the send's request
     * id, so the page can swap its greyed pending copy for the real message (see
     * `composer-outbox.ts`). */
    onSentMessage?: (idempotencyKey: string, messageId: string) => void;
    /** A message's reactions after a write, heard whether or not the tab is visible: applying
     * it reads nothing. */
    onReaction?: (event: MessageReactionEvent) => void;
    /** A resubscribe could not replay every missed publication: the loaded messages' reactions
     * may be stale. A first subscribe does not count: a reaction between the page's read and it
     * waits for the next. */
    onPublicationsLost?: () => void;
    /** A member's top-level read position moved forward. */
    onRead?: (event: ConversationReadEvent) => void;
  },
) {
  const channel = conversationRealtimeChannel(input.conversationId);
  const requestReconciliation = (options?: { restart?: boolean }) => {
    if (document.visibilityState === "visible") input.reconcile(options);
  };
  // Left: a first subscribe's comparison that settles later does nothing.
  let closed = false;
  /** A first subscribe reads again only what the stream moved past: the messages past the window's
   * last read, the member lists past where the page opened it. */
  const catchUpFirstSubscribe = async (
    recovery: SubscribedRecovery,
    readPosition: () => Promise<StreamPosition | undefined>,
  ) => {
    const [messages, members] = await Promise.all([
      missedBySubscribe(recovery, readPosition),
      missedBySubscribe(recovery, () => input.openedAt),
    ]);
    if (closed) return;
    if (messages) requestReconciliation({ restart: true });
    else input.onCaughtUp?.();
    if (members) input.onMemberChanged?.("page-payload");
  };
  const releaseSubscription = subscribeToSharedRealtime(client, {
    channel,
    recoverable: true,
    positioned: true,
    getToken: input.getToken,
    onSubscribed: (context) => {
      // Anything the subscription could not replay — before the first subscribe, or across a
      // resubscribe that lost publications — may include a member change as well as messages.
      const gap = subscriptionGap(context);
      if (gap === "none") return;
      if (gap === "unrecovered" && input.readPosition) {
        void catchUpFirstSubscribe(context, input.readPosition).catch((error: unknown) =>
          console.error(`realtime catch-up failed on ${channel}`, error),
        );
        return;
      }
      requestReconciliation({ restart: true });
      if (gap === "lost") input.onPublicationsLost?.();
      input.onMemberChanged?.(gap === "unrecovered" ? "page-payload" : "all");
    },
    onPublication: ({ data }) => {
      try {
        const event = decodeMessageAvailableEvent(data);
        if (event.conversationId !== input.conversationId) return;
        if (event.idempotencyKey) input.onSentMessage?.(event.idempotencyKey, event.messageId);
        requestReconciliation();
        return;
      } catch {}
      const reaction = decodeMessageReactionEvent(data);
      if (reaction) {
        if (reaction.conversationId === input.conversationId) input.onReaction?.(reaction);
        return;
      }
      const read = decodeConversationReadEvent(data);
      if (read) {
        if (read.conversationId === input.conversationId) input.onRead?.(read);
        return;
      }
      // Not a message event: the other payloads this channel carries are a membership change,
      // which stale-dates the member directory, and a change to the channel's own facts. Neither
      // touches the message window.
      try {
        const event = decodeMemberChangedEvent(data);
        if (event.conversationId === input.conversationId) input.onMemberChanged?.("all");
        return;
      } catch {}
      try {
        const event = decodeChannelUpdatedEvent(data);
        if (event.conversationId === input.conversationId) input.onChannelUpdated?.();
      } catch {}
    },
  });
  const onBack = () => requestReconciliation({ restart: true });
  // Restored from the back-forward cache (iOS Safari's usual way back), which need not fire
  // `visibilitychange`.
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) onBack();
  };
  const safetyTimer = window.setInterval(() => requestReconciliation(), 30_000);
  document.addEventListener("visibilitychange", onBack);
  window.addEventListener("online", onBack);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    closed = true;
    window.clearInterval(safetyTimer);
    document.removeEventListener("visibilitychange", onBack);
    window.removeEventListener("online", onBack);
    window.removeEventListener("pageshow", onPageShow);
    releaseSubscription();
  };
}

export function useConversationRealtime(
  conversationId: string,
  reconcile: (options?: { restart?: boolean }) => Promise<void>,
  onMemberChanged?: (stale: MemberDirectoryStale) => void,
  onChannelUpdated?: () => void,
  onReaction?: (event: MessageReactionEvent) => void,
  onPublicationsLost?: () => void,
  onRead?: (event: ConversationReadEvent) => void,
  /** The Query holding the conversation's window (`key`), whose newest page carries its stream
   * position, and what to call when a first subscribe found nothing new since it was read
   * (`caughtUp`); without it, every first subscribe catches up. */
  windowQuery?: { key: QueryKey; caughtUp: () => void },
) {
  const client = useBrowserRealtime();
  const queryClient = useQueryClient();
  const getToken = useServerFn(getConversationRealtimeToken);
  const windowRef = useRef(windowQuery);
  windowRef.current = windowQuery;
  // Where the window stood when this conversation opened here, which its member lists were seeded
  // from: kept across a resubscribe of the same conversation, which may follow a refetch.
  const opened = useRef<{ conversationId: string; at: StreamPosition | undefined }>(undefined);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  const memberChangedRef = useRef(onMemberChanged);
  memberChangedRef.current = onMemberChanged;
  const channelUpdatedRef = useRef(onChannelUpdated);
  channelUpdatedRef.current = onChannelUpdated;
  const reactionRef = useRef(onReaction);
  reactionRef.current = onReaction;
  const publicationsLostRef = useRef(onPublicationsLost);
  publicationsLostRef.current = onPublicationsLost;
  const readRef = useRef(onRead);
  readRef.current = onRead;

  useEffect(() => {
    if (!client || !conversationId) return;
    return subscribeToConversationRealtime(client, {
      conversationId,
      getToken: () => getToken({ data: { conversationId } }),
      ...windowPositions(queryClient, windowRef.current?.key, conversationId, opened),
      onCaughtUp: () => windowRef.current?.caughtUp(),
      reconcile: (options) => void reconcileRef.current(options).catch(() => {}),
      onMemberChanged: (stale) => memberChangedRef.current?.(stale),
      onChannelUpdated: () => channelUpdatedRef.current?.(),
      onSentMessage: (idempotencyKey, messageId) =>
        deviceComposerOutbox().acknowledge(idempotencyKey, messageId),
      onReaction: (event) => reactionRef.current?.(event),
      onPublicationsLost: () => publicationsLostRef.current?.(),
      onRead: (event) => readRef.current?.(event),
    });
  }, [client, conversationId, getToken, queryClient]);
}

type PositionedWindow = { pages: { streamPositions?: StreamPositions }[] };
const newestPositions = (data: PositionedWindow | undefined) => data?.pages.at(-1)?.streamPositions;

/** Where the conversation's window stands in its stream for `subscribeToConversationRealtime`: as
 * it opened (`openedAt`, kept in `opened` per conversation), and once a read of it under way
 * settles (`readPosition`). */
function windowPositions(
  queryClient: QueryClient,
  windowKey: QueryKey | undefined,
  conversationId: string,
  opened: { current: { conversationId: string; at: StreamPosition | undefined } | undefined },
) {
  if (!windowKey) return {};
  const channel = conversationRealtimeChannel(conversationId);
  if (opened.current?.conversationId !== conversationId)
    opened.current = {
      conversationId,
      at: newestPositions(queryClient.getQueryData<PositionedWindow>(windowKey))?.[channel],
    };
  return {
    openedAt: opened.current.at,
    readPosition: () => queryStreamPosition(queryClient, windowKey, channel, newestPositions),
  };
}
