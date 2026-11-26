import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";

import {
  useBrowserRealtime,
  subscribeToSharedRealtime,
  type SharedRealtimeClient,
} from "#src/features/realtime/browser-realtime";
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

export type MemberDirectoryStale = "page-payload" | "all";

export function subscribeToConversationRealtime(
  client: SharedRealtimeClient,
  input: {
    conversationId: string;
    readPosition?: () => Promise<StreamPosition | undefined>;
    openedAt?: StreamPosition;
    onCaughtUp?: () => void;
    reconcile: (options?: { restart?: boolean }) => void;
    onMemberChanged?: (stale: MemberDirectoryStale) => void;
    onChannelUpdated?: () => void;
    onSentMessage?: (idempotencyKey: string, messageId: string) => void;
    onReaction?: (event: MessageReactionEvent) => void;
    onPublicationsLost?: () => void;
    onRead?: (event: ConversationReadEvent) => void;
  },
) {
  const channel = conversationRealtimeChannel(input.conversationId);
  const requestReconciliation = (options?: { restart?: boolean }) => {
    if (document.visibilityState === "visible") input.reconcile(options);
  };
  let closed = false;
  let subscribed = false;
  let safetyTimer: number | undefined;
  const startSafetyTimer = () => {
    if (closed || safetyTimer !== undefined) return;
    safetyTimer = window.setInterval(() => requestReconciliation(), 30_000);
  };
  const stopSafetyTimer = () => {
    if (safetyTimer === undefined) return;
    window.clearInterval(safetyTimer);
    safetyTimer = undefined;
  };
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
    onSubscribed: (context) => {
      subscribed = true;
      stopSafetyTimer();
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
    onSubscribing: () => {
      subscribed = false;
      startSafetyTimer();
    },
    onError: () => {
      subscribed = false;
      startSafetyTimer();
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
  if (!subscribed) startSafetyTimer();
  const onBack = () => requestReconciliation({ restart: true });
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) onBack();
  };
  document.addEventListener("visibilitychange", onBack);
  window.addEventListener("online", onBack);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    closed = true;
    stopSafetyTimer();
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
  windowQuery?: { key: QueryKey; caughtUp: () => void },
) {
  const client = useBrowserRealtime();
  const queryClient = useQueryClient();
  const windowRef = useRef(windowQuery);
  windowRef.current = windowQuery;
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
  }, [client, conversationId, queryClient]);
}

type PositionedWindow = { pages: { streamPositions?: StreamPositions }[] };
const newestPositions = (data: PositionedWindow | undefined) => data?.pages.at(-1)?.streamPositions;

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
