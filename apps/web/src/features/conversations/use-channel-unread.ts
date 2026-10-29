import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import type { StreamPosition, SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";
import {
  decodeConversationActivityEvent,
  decodeViewerEvent,
  userConversationChannel,
  workspaceConversationChannel,
  type ConversationActivityEvent,
} from "./conversation-realtime";
import {
  applyMarked,
  applyUnreadEvent,
  channelSignalOf,
  closedConversationLists,
  clearUnread,
  rereadMissedBySubscribe,
  replaceUnreadCounts,
  sidebarListsChangedBy,
  storedCursorMove,
  type ChatList,
  type UnreadChannel,
  type UnreadCounts,
  type UnreadEventInput,
} from "./conversation-unread";
import type { ChannelSignal } from "./channel-signals";

export type UnreadState = {
  counts: UnreadCounts;
  clear: (key: string, readThroughSequence?: number) => void;
  replace: (entries: readonly UnreadChannel[], keepIds?: ReadonlySet<string>) => void;
};

/**
 * The Chat page's two signal subscriptions and its unread-count state. Renders nothing: the
 * directory reads `counts`, the conversation routes call `clear`, and every loader refresh
 * flows through `replace`. Both subscriptions ride the Workspace layout's one Centrifuge
 * connection; neither opens a WebSocket of its own.
 */
export function useChannelUnread({
  workspaceId,
  userId,
  channels,
  openConversationId,
  listedConversationIds,
  onClosedConversationActivity,
  onChannelSignal,
  onSidebarListsChanged,
  onConversationActivity,
  readPosition,
  onReadCursorMoved,
}: {
  workspaceId?: string;
  /** The viewer, whose own direct-message signal channel carries their DM badges, and whose own
   * messages never count. */
  userId?: string;
  /** Channel rows currently listed; channel events for anything else are ignored. */
  channels: readonly UnreadChannel[];
  /** The channel or DM currently shown in the detail pane, if any. */
  openConversationId?: string;
  /** Every chat the sidebar lists, channels and DMs, by conversation id. */
  listedConversationIds: ReadonlySet<string>;
  /** A new message arrived in a closed chat, or a DM the list has not read yet: these lists
   * bring it in. */
  onClosedConversationActivity: (lists: readonly ChatList[], event: UnreadEventInput) => void;
  /** A channel was created, renamed, described, archived, unarchived or is gone
   * (`channel.created.v1`, `channel.updated.v1`). */
  onChannelSignal: (signal: ChannelSignal) => void;
  /** These lists are stale: the viewer's own place in a chat changed elsewhere (`ViewerEvent`),
   * or a subscribe may have missed what kept them live (`listsMissedBySubscribe`). */
  onSidebarListsChanged: (lists: readonly ChatList[]) => void;
  /** Where a list was read in a signal channel's stream, once a read of it under way has settled;
   * it settles to undefined for a list read without one (`useListReadPosition`,
   * `listReadPosition`), which is then re-read. */
  readPosition: (
    list: ChatList,
    channel: string,
  ) => Promise<StreamPosition | undefined> | undefined;
  /** The viewer's read cursor in a conversation moved, here or elsewhere (`storedCursorMove`). */
  onReadCursorMoved: (move: ReturnType<typeof storedCursorMove>) => void;
  /** One message in a chat the sidebar lists: write that row from the event, no read. */
  onConversationActivity: (event: ConversationActivityEvent) => void;
}): UnreadState {
  const [counts, setCounts] = useState<UnreadCounts>({});
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const refs = useRef({
    userId,
    channels,
    openConversationId,
    listedConversationIds,
    onClosedConversationActivity,
    onChannelSignal,
    onSidebarListsChanged,
    readPosition,
    onReadCursorMoved,
    onConversationActivity,
  });
  refs.current = {
    userId,
    channels,
    openConversationId,
    listedConversationIds,
    onClosedConversationActivity,
    onChannelSignal,
    onSidebarListsChanged,
    readPosition,
    onReadCursorMoved,
    onConversationActivity,
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
    getToken: workspaceId ? getWorkspaceToken : undefined,
    onPublication,
    onSubscribed: (recovery) => {
      if (workspaceId)
        void rereadMissed("workspace", workspaceConversationChannel(workspaceId), recovery);
    },
  });
  // The viewer's own channel carries their `ViewerEvent`s and every message they may read: their
  // channels' and their direct conversations' alike.
  const onUserPublication = useCallback((publication: { data: unknown }) => {
    const event = decodeViewerEvent(publication.data);
    if (event) {
      if ("unreadCount" in event) {
        const open = refs.current.openConversationId;
        setCounts((current) => applyMarked(current, event, { openConversationId: open }));
        refs.current.onReadCursorMoved(storedCursorMove(event, open));
      }
      const lists = sidebarListsChangedBy(event);
      if (lists.length > 0) refs.current.onSidebarListsChanged(lists);
      return;
    }
    const activity = decodeConversationActivityEvent(publication.data);
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
    // A chat the list does not hold is brought in by a read of that one list; every other row is
    // written from the event itself.
    if (stale.length > 0) reopenFromActivity(stale, message);
    else writeRow(activity);
    setCounts((current) =>
      applyUnreadEvent(current, message, {
        conversations,
        openConversationId: open,
        viewerId,
      }),
    );
  }, []);
  useRealtimeSubscription({
    channel: userId ? userConversationChannel(userId) : undefined,
    getToken: userId ? getUserToken : undefined,
    onPublication: onUserPublication,
    onSubscribed: (recovery) => {
      if (userId) void rereadMissed("user", userConversationChannel(userId), recovery);
    },
  });

  const clear = useCallback(
    (key: string, readThroughSequence?: number) =>
      setCounts((current) => clearUnread(current, key, readThroughSequence)),
    [],
  );
  const replace = useCallback((next: readonly UnreadChannel[], keepIds?: ReadonlySet<string>) => {
    // The conversation on screen keeps no badge, exactly like a live event for it; leaving the
    // conversation lets the next server read seed it again.
    const open = refs.current.openConversationId;
    setCounts((current) =>
      replaceUnreadCounts(current, next, new Set(open ? [open] : []), keepIds),
    );
  }, []);
  return { counts, clear, replace };
}
