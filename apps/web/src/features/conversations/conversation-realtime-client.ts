import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  useBrowserRealtime,
  subscribeToSharedRealtime,
  type SharedRealtimeClient,
} from "#src/features/realtime/browser-realtime";
import { getConversationRealtimeToken } from "#src/features/realtime/realtime.functions";
import { subscriptionGap } from "#src/features/realtime/subscription-gap";
import {
  conversationRealtimeChannel,
  decodeChannelUpdatedEvent,
  decodeAgentReadEvent,
  decodeMemberChangedEvent,
  decodeMessageAvailableEvent,
  decodeMessageReactionEvent,
  type MessageReactionEvent,
  type AgentReadEvent,
} from "./conversation-realtime";
import { deviceComposerOutbox } from "./use-message-outbox";

/** Which member lists a missed membership change may have stale-dated (see `onMemberChanged`). */
export type MemberDirectoryStale = "page-payload" | "all";

export function subscribeToConversationRealtime(
  client: SharedRealtimeClient,
  input: {
    conversationId: string;
    getToken: () => Promise<string>;
    reconcile: () => void;
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
     * may be stale. A first subscribe does not count: the page's read carries no stream position
     * to compare (`streamMovedSince`), so a change between that read and it waits for the next. */
    onPublicationsLost?: () => void;
    onAgentReadChanged?: (event: AgentReadEvent) => void;
  },
) {
  const channel = conversationRealtimeChannel(input.conversationId);
  const requestReconciliation = () => {
    if (document.visibilityState === "visible") input.reconcile();
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
      requestReconciliation();
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
      const agentRead = decodeAgentReadEvent(data);
      if (agentRead) {
        if (agentRead.conversationId === input.conversationId)
          input.onAgentReadChanged?.(agentRead);
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
  const onVisibilityChange = () => requestReconciliation();
  const onOnline = () => requestReconciliation();
  const safetyTimer = window.setInterval(requestReconciliation, 30_000);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(safetyTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onOnline);
    releaseSubscription();
  };
}

export function useConversationRealtime(
  conversationId: string,
  reconcile: () => Promise<void>,
  onMemberChanged?: (stale: MemberDirectoryStale) => void,
  onChannelUpdated?: () => void,
  onReaction?: (event: MessageReactionEvent) => void,
  onPublicationsLost?: () => void,
  onAgentReadChanged?: (event: AgentReadEvent) => void,
) {
  const client = useBrowserRealtime();
  const getToken = useServerFn(getConversationRealtimeToken);
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
  const agentReadRef = useRef(onAgentReadChanged);
  agentReadRef.current = onAgentReadChanged;

  useEffect(() => {
    if (!client || !conversationId) return;
    return subscribeToConversationRealtime(client, {
      conversationId,
      getToken: () => getToken({ data: { conversationId } }),
      reconcile: () => void reconcileRef.current().catch(() => {}),
      onMemberChanged: (stale) => memberChangedRef.current?.(stale),
      onChannelUpdated: () => channelUpdatedRef.current?.(),
      onSentMessage: (idempotencyKey, messageId) =>
        deviceComposerOutbox().acknowledge(idempotencyKey, messageId),
      onReaction: (event) => reactionRef.current?.(event),
      onPublicationsLost: () => publicationsLostRef.current?.(),
      onAgentReadChanged: (event) => agentReadRef.current?.(event),
    });
  }, [client, conversationId, getToken]);
}
