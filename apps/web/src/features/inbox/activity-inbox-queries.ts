import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  replaceEqualDeep,
  type QueryClient,
} from "@tanstack/react-query";

import {
  userConversationChannel,
  type ActivityAttention,
} from "#src/features/conversations/conversation-realtime";
import { rereadQueryMissedBySubscribe } from "#src/features/realtime/query-stream-position";
import type {
  StreamPosition,
  StreamPositions,
  SubscribedRecovery,
} from "#src/features/realtime/subscription-gap";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

import {
  loadActivityInbox,
  loadActivityNavAttention,
  loadWaitingChoiceCards,
} from "./activity-inbox.functions";
import type { ActivityInboxCursor, ActivityInboxFilter } from "./activity-inbox.schemas";
import {
  applyActivityMessage,
  type ActivityUnreadMessage,
  type ActivityUnreadState,
} from "./activity-unread-count";
import { isViewingItem } from "./viewing-items";

export const ACTIVITY_INBOX_QUERY_PREFIX = ["activity-inbox"] as const;

export const ACTIVITY_INBOX_LISTS_KEY = [...ACTIVITY_INBOX_QUERY_PREFIX, "list"] as const;

export const activityInboxQuery = (workspaceId: string, filter: ActivityInboxFilter) =>
  infiniteQueryOptions({
    queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId, filter],
    queryFn: ({ pageParam }) => loadActivityInbox({ data: { filter, cursor: pageParam } }),
    initialPageParam: undefined as ActivityInboxCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    structuralSharing: (held: unknown, next: unknown) =>
      replaceEqualDeep(held, keepLaterFirstPage(held as ReadPages, next as ReadPages)),
  });

export function invalidateActivityInboxLists(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId],
    refetchType: "none",
  });
}

type StreamRead = { streamPositions: StreamPositions };
type ReadPages = InfiniteData<StreamRead> | undefined;

export function keepLaterFirstPage<Data extends ReadPages>(held: Data, next: Data): Data {
  const kept = held?.pages[0];
  const incoming = next?.pages[0];
  if (!next || !kept || !incoming || !readEarlier(incoming, kept)) return next;
  return { ...next, pages: [kept, ...next.pages.slice(1)] };
}

export type ActivityInboxPage = Awaited<ReturnType<typeof loadActivityInbox>>;

export type ActivityCompletionItem = Pick<
  ActivityInboxItem,
  "key" | "unreadCount" | "unreadMention"
>;
type ActivityCompletionPage<Item extends ActivityCompletionItem = ActivityCompletionItem> = Pick<
  ActivityInboxPage,
  "unreadItemCount" | "unreadMentionItemCount" | "activeItemCount"
> & { items: Item[]; pinned?: Item[] };

export async function cancelActivityInboxListReads(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId] });
}

export function projectPendingActivityCompletions<
  Item extends ActivityCompletionItem,
  Page extends ActivityCompletionPage<Item>,
>(data: InfiniteData<Page>, items: Iterable<ActivityCompletionItem>): InfiniteData<Page> {
  let projected = data;
  for (const item of items) projected = withoutItem(projected, item);
  return projected;
}

function withoutItem<
  Item extends ActivityCompletionItem,
  Page extends ActivityCompletionPage<Item>,
>(data: InfiniteData<Page>, item: ActivityCompletionItem): InfiniteData<Page> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((entry) => entry.key !== item.key),
      ...(page.pinned ? { pinned: page.pinned.filter((entry) => entry.key !== item.key) } : {}),
      unreadItemCount: Math.max(0, page.unreadItemCount - (item.unreadCount > 0 ? 1 : 0)),
      unreadMentionItemCount: Math.max(
        0,
        page.unreadMentionItemCount - (item.unreadMention ? 1 : 0),
      ),
      activeItemCount: Math.max(0, page.activeItemCount - 1),
    })),
  };
}

export const WAITING_CHOICE_CARDS_KEY = ["waiting-choice-cards"] as const;

export const waitingChoiceCardsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: [...WAITING_CHOICE_CARDS_KEY, workspaceId],
    queryFn: () => loadWaitingChoiceCards(),
  });

export const activityNavAttentionQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: [...ACTIVITY_INBOX_QUERY_PREFIX, "nav-attention", workspaceId],
    queryFn: (): Promise<ActivityNavAttention> => loadActivityNavAttention(),
    staleTime: 30_000,
    structuralSharing: (held: unknown, next: unknown) =>
      held && readEarlier(next as ActivityNavAttention, held as ActivityNavAttention)
        ? held
        : replaceEqualDeep(held, next),
  });

function readEarlier(answer: StreamRead, than: StreamRead) {
  return Object.entries(answer.streamPositions).some(([channel, at]) => {
    const held = than.streamPositions[channel];
    return held !== undefined && held.epoch === at.epoch && at.offset < held.offset;
  });
}

export function activityNavAttentionRealtime(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
  { rereadIntervalMs = 10_000 }: { rereadIntervalMs?: number } = {},
): {
  onMessage: (
    message: ActivityUnreadMessage & { workspaceId: string },
    position: StreamPosition | undefined,
  ) => void;
  onActivity: () => void;
  onAttention: (attention: ActivityAttention, workspaceId: string) => void;
  onSubscribed: (recovery: SubscribedRecovery) => void;
} {
  const queryKey = activityNavAttentionQuery(workspaceId).queryKey;
  const channel = userConversationChannel(userId);
  const reread = () => void queryClient.invalidateQueries({ queryKey });
  let lastThrottledRead = Number.NEGATIVE_INFINITY;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const rereadThrottled = () => {
    if (waiting) return;
    const wait = lastThrottledRead + rereadIntervalMs - Date.now();
    if (wait <= 0) {
      lastThrottledRead = Date.now();
      return reread();
    }
    waiting = setTimeout(() => {
      waiting = undefined;
      lastThrottledRead = Date.now();
      reread();
    }, wait);
  };
  let litBy: { position: StreamPosition | undefined } | undefined;
  return {
    onMessage: (message, position) => {
      if (message.workspaceId !== workspaceId) return;
      const current = queryClient.getQueryData<ActivityNavAttention>(queryKey) ?? {
        hasUnread: false,
      };
      const {
        state,
        reread: needsRead,
        lights,
      } = applyActivityMessage(current, message, {
        viewerUserId: userId,
        isViewing: isViewingItem,
      });
      if (needsRead) rereadThrottled();
      if (!lights) return;
      litBy = { position };
      if (state === current) return;
      queryClient.setQueryData<ActivityNavAttention>(queryKey, (held) => ({
        streamPositions: {},
        ...held,
        ...state,
      }));
    },
    onActivity: reread,
    onAttention: ({ hasUnread, streamPosition, unreadCount, unreadKeys }, from) => {
      if (from !== workspaceId) return;
      let lateCount = false;
      if (litBy) {
        const lit = litBy.position;
        const comparable = streamPosition && lit && streamPosition.epoch === lit.epoch;
        if (!hasUnread) {
          if (!comparable) {
            litBy = undefined;
            return reread();
          }
          if (streamPosition.offset < lit.offset) {
            const held = queryClient.getQueryData<ActivityNavAttention>(queryKey);
            if (held?.unreadCount !== undefined) reread();
            return;
          }
          litBy = undefined;
        } else if (comparable && streamPosition.offset >= lit.offset) {
          litBy = undefined;
        } else if (unreadCount !== undefined) {
          lateCount = true;
        }
      }
      queryClient.setQueryData<ActivityNavAttention>(queryKey, (current) => ({
        hasUnread,
        ...(unreadCount !== undefined ? { unreadCount } : {}),
        ...(unreadKeys ? { unreadKeys } : {}),
        streamPositions: streamPosition
          ? { [channel]: streamPosition }
          : (current?.streamPositions ?? {}),
      }));
      if (lateCount) reread();
    },
    onSubscribed: (recovery) =>
      void rereadQueryMissedBySubscribe(queryClient, queryKey, channel, recovery, reread),
  };
}

type ActivityNavAttention = Awaited<ReturnType<typeof loadActivityNavAttention>> &
  Pick<ActivityUnreadState, "unreadCount" | "unreadKeys">;
