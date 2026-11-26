import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { publicationDataOrUndefined } from "#src/features/realtime/publication-data";
import type { StreamPosition, SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import {
  decodeViewerEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "./conversation-realtime";
import type { MarkedEventUnreadPayload } from "./sidebar-unread-state";
import {
  decodeConversationActivityEvent,
  type ConversationActivityEvent,
} from "./conversation-activity-event";
import {
  applyMarked,
  applyUnreadEvent,
  channelSignalOf,
  closedConversationLists,
  rereadMissedBySubscribe,
  replaceUnreadCounts,
  listsChangedIn,
  type ChatList,
  type UnreadChannel,
  type UnreadEventInput,
} from "./conversation-unread";
import type { ChannelSignal } from "./channel-signals";
import { UnreadStore } from "./unread-store";
import { markOpenReadStale } from "./conversation-open-query";
import { applyThreadUnreadChangeToConversationCaches } from "./thread-cache";

export type UnreadState = {
  store: UnreadStore;
  replace: (entries: readonly UnreadChannel[], keepIds?: ReadonlySet<string>) => void;
};

/**
 * The Chat page's two signal subscriptions and its unread counts (`UnreadStore`). Renders nothing,
 * and a count that moves renders nothing here either: each directory row reads its own count from
 * the store, the conversation routes clear theirs, and every loader refresh flows through
 * `replace`. Both subscriptions ride the Workspace layout's one Centrifuge connection; neither
 * opens a WebSocket of its own.
 */
export function useChannelUnread({
  workspaceId,
  userId,
  channels,
  openConversationId,
  threadChannelIds,
  listedConversationIds,
  onClosedConversationActivity,
  onChannelSignal,
  onSidebarListsChanged,
  onConversationActivity,
  onConversationMarked,
  readPosition,
}: {
  workspaceId?: string;
  userId?: string;
  channels: readonly UnreadChannel[];
  openConversationId?: string;
  threadChannelIds: readonly string[];
  listedConversationIds: ReadonlySet<string>;
  onClosedConversationActivity: (lists: readonly ChatList[], event: UnreadEventInput) => void;
  onChannelSignal: (signal: ChannelSignal) => void;
  onSidebarListsChanged: (lists: readonly ChatList[]) => void;
  readPosition: (
    list: ChatList,
    channel: string,
  ) => Promise<StreamPosition | undefined> | undefined;
  onConversationActivity: (
    event: ConversationActivityEvent,
    options?: { openConversationId?: string },
  ) => void;
  onConversationMarked?: (
    event: MarkedEventUnreadPayload,
    options: { openConversationId?: string },
  ) => void;
}): UnreadState {
  const [store] = useState(() => new UnreadStore());
  const queryClient = useQueryClient();
  useEffect(() => {
    store.setThreadWorkspace(userId ? workspaceId : undefined);
    return () => store.setThreadWorkspace(undefined);
  }, [store, userId, workspaceId]);
  useEffect(() => {
    store.setThreadChannels(threadChannelIds);
  }, [store, threadChannelIds, userId, workspaceId]);

  const refs = useRef({
    workspaceId,
    userId,
    channels,
    openConversationId,
    listedConversationIds,
    onClosedConversationActivity,
    onChannelSignal,
    onSidebarListsChanged,
    readPosition,
    onConversationActivity,
    onConversationMarked,
  });
  refs.current = {
    workspaceId,
    userId,
    channels,
    openConversationId,
    listedConversationIds,
    onClosedConversationActivity,
    onChannelSignal,
    onSidebarListsChanged,
    readPosition,
    onConversationActivity,
    onConversationMarked,
  };
  const rereadMissed = useCallback(
    (kind: "workspace" | "user", channel: string, recovery: SubscribedRecovery) =>
      rereadMissedBySubscribe(
        kind,
        recovery,
        (list) => refs.current.readPosition(list, channel),
        (lists) => refs.current.onSidebarListsChanged(lists),
      ),
    [],
  );

  // The Workspace channel carries channel facts and Task changes only: a message never reaches
  // every member's tab, so nothing here counts one.
  const onPublication = useCallback((publication: { data: unknown }) => {
    const signal = channelSignalOf(publication.data);
    if (signal) refs.current.onChannelSignal(signal);
  }, []);

  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication,
    onSubscribed: (recovery) => {
      if (workspaceId)
        void rereadMissed("workspace", workspaceConversationChannel(workspaceId), recovery);
    },
  });
  // The viewer's own channel carries their `ViewerEvent`s and every message they may read: their
  // channels' and their direct conversations' alike.
  const onUserPublication = useCallback(
    (publication: { data: unknown }) => {
      // Parsed once for the decoders below, each of which takes it as it is.
      const data = publicationDataOrUndefined(publication.data);
      const event = decodeViewerEvent(data);
      if (event) {
        if (event.type === REALTIME_EVENTS.threadUnreadChanged) {
          if (event.workspaceId === refs.current.workspaceId) {
            applyThreadUnreadChangeToConversationCaches(queryClient, event);
            markOpenReadStale(queryClient, event.conversationId, event.rootMessageId);
          }
          return;
        }
        if (event.type === REALTIME_EVENTS.channelThreadUnreadInvalidated) {
          store.invalidateThreadUnread(event.workspaceId, event.conversationId);
          return;
        }
        if ("unreadCount" in event) {
          const open = refs.current.openConversationId;
          store.update((current) => applyMarked(current, event, { openConversationId: open }));
          refs.current.onConversationMarked?.(event, { openConversationId: open });
          markOpenReadStale(queryClient, event.conversationId);
        }
        const lists = listsChangedIn(refs.current.workspaceId, event);
        if (lists.length > 0) refs.current.onSidebarListsChanged(lists);
        return;
      }
      // A private channel's events come here instead of the Workspace channel. This channel is the
      // viewer's in every Workspace, so another Workspace's are dropped.
      const signal = channelSignalOf(data);
      if (signal) {
        if (signal.workspaceId === refs.current.workspaceId) refs.current.onChannelSignal(signal);
        return;
      }
      const activity = decodeConversationActivityEvent(data);
      if (!activity) return;
      // The badge rule needs only the shape below; the row writer gets the whole event, whose
      // preview and sender are what the row shows.
      const message: UnreadEventInput = {
        conversationId: activity.conversationId,
        sequence: activity.sequence,
        kind: activity.kind,
        senderKind: activity.sender.kind,
        ...(activity.threadRootId ? { threadRootId: activity.threadRootId } : {}),
        ...(activity.senderUserId ? { senderUserId: activity.senderUserId } : {}),
        ...(activity.senderAgentId ? { senderAgentId: activity.senderAgentId } : {}),
      };
      const {
        channels: channelRows,
        openConversationId: open,
        listedConversationIds: listed,
        onClosedConversationActivity: reopenFromActivity,
        onConversationActivity: writeRow,
      } = refs.current;
      const conversations = new Set(channelRows.map((channel) => channel.id));
      const viewerId = refs.current.userId;
      const stale = closedConversationLists(message, listed, viewerId);
      if (stale.length > 0) reopenFromActivity(stale, message);
      else writeRow(activity, { openConversationId: open });
      store.update((current) =>
        applyUnreadEvent(current, message, {
          conversations,
          openConversationId: open,
          viewerId,
        }),
      );
    },
    [queryClient, store],
  );
  useRealtimeSubscription({
    channel: userId ? userConversationChannel(userId) : undefined,
    onPublication: onUserPublication,
    onSubscribed: (recovery) => {
      if (userId) {
        store.refreshThreadUnreads();
        void rereadMissed("user", userConversationChannel(userId), recovery);
      }
    },
  });

  const replace = useCallback((next: readonly UnreadChannel[], keepIds?: ReadonlySet<string>) => {
    // The conversation on screen keeps no badge, exactly like a live event for it; leaving the
    // conversation lets the next server read seed it again.
    const open = refs.current.openConversationId;
    store.update((current) =>
      replaceUnreadCounts(current, next, new Set(open ? [open] : []), keepIds),
    );
  }, []);
  return { store, replace };
}
