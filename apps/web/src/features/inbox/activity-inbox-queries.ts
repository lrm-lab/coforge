import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import {
  userConversationChannel,
  type ActivityAttention,
} from "#src/features/conversations/conversation-realtime";
import { rereadQueryMissedBySubscribe } from "#src/features/realtime/query-stream-position";
import type { StreamPosition, SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

import { loadActivityInbox, loadActivityNavAttention } from "./activity-inbox.functions";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

/** Every cached page of every view shares this prefix, so one invalidation refreshes them all. */
export const ACTIVITY_INBOX_QUERY_PREFIX = ["activity-inbox"] as const;

/** Every paged list view, and nothing else under the prefix (the nav dot is not paged). */
export const ACTIVITY_INBOX_LISTS_KEY = [...ACTIVITY_INBOX_QUERY_PREFIX, "list"] as const;

/** One view of the viewer's Activity inbox, paged by list offset. */
export const activityInboxQuery = (workspaceId: string, filter: ActivityInboxFilter) =>
  infiniteQueryOptions({
    queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId, filter],
    queryFn: ({ pageParam }) => loadActivityInbox({ data: { filter, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });

export type ActivityInboxPage = Awaited<ReturnType<typeof loadActivityInbox>>;

export type ActivityCompletionItem = Pick<
  ActivityInboxItem,
  "key" | "unreadCount" | "unreadMention" | "pinned"
>;
type ActivityCompletionPage<Item extends ActivityCompletionItem = ActivityCompletionItem> = Pick<
  ActivityInboxPage,
  "unreadItemCount" | "unreadMentionItemCount" | "activeItemCount"
> & { items: Item[] };

/** Cancels list reads that predate a Done action. A pending projection below also fences reads
 * started later, while another Done action settles or realtime invalidates the list. */
export async function cancelActivityInboxListReads(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId] });
}

/** Hides every pending Done item from fetched data until its write and canonical refresh settle. */
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
      unreadItemCount: Math.max(0, page.unreadItemCount - (item.unreadCount > 0 ? 1 : 0)),
      unreadMentionItemCount: Math.max(
        0,
        page.unreadMentionItemCount - (item.unreadMention ? 1 : 0),
      ),
      activeItemCount: Math.max(0, page.activeItemCount - (item.pinned ? 0 : 1)),
    })),
  };
}

/** Whether the viewer has unread activity, for the nav rail's Activity dot. Shares the inbox's
 * query prefix, so every list refresh also refreshes the dot. An answer read from further back in
 * the viewer's channel than the one held never replaces it: a read begun before a write in another
 * tab ends after that write's announcement (`ActivityAttention`), and keeps it. */
export const activityNavAttentionQuery = () =>
  queryOptions({
    queryKey: [...ACTIVITY_INBOX_QUERY_PREFIX, "nav-attention"],
    queryFn: () => loadActivityNavAttention(),
    staleTime: 30_000,
    structuralSharing: (held: unknown, next: unknown) =>
      held && readEarlier(next as ActivityNavAttention, held as ActivityNavAttention) ? held : next,
  });

/** Whether `answer` was read at an earlier place in a channel than `than`, in the same epoch. */
function readEarlier(answer: ActivityNavAttention, than: ActivityNavAttention) {
  return Object.entries(answer.streamPositions).some(([channel, at]) => {
    const held = than.streamPositions[channel];
    return held !== undefined && held.epoch === at.epoch && at.offset < held.offset;
  });
}

/**
 * The nav dot's realtime reactions. A message the server already filtered to the viewer can only
 * add attention, so it lights the dot without a read. A write of theirs that can clear it, in any
 * of their pages, announces where the inbox stands (`ActivityAttention`), and the dot takes that
 * as it is, unless a message lit it here past the place the server read from, which keeps it lit;
 * when the two places cannot be compared, the dot reads again. Any other `activity.changed.v1` (a
 * mention from outside the channel, a Task assignment) says nothing of which way it went, so it
 * re-reads.
 */
export function activityNavAttentionRealtime(
  queryClient: QueryClient,
  userId: string,
): {
  onMessage: (event: unknown, position: StreamPosition | undefined) => void;
  onActivity: () => void;
  onAttention: (attention: ActivityAttention) => void;
  onSubscribed: (recovery: SubscribedRecovery) => void;
} {
  const queryKey = activityNavAttentionQuery().queryKey;
  const channel = userConversationChannel(userId);
  const reread = () => void queryClient.invalidateQueries({ queryKey });
  // The newest message that lit the dot here, by where it stands in the viewer's channel.
  let litBy: { position: StreamPosition | undefined } | undefined;
  return {
    // The read's stream positions stay: a message delivered here moved the dot without a read.
    onMessage: (_event, position) => {
      litBy = { position };
      queryClient.setQueryData<ActivityNavAttention>(queryKey, (current) => ({
        streamPositions: {},
        ...current,
        hasUnread: true,
      }));
    },
    onActivity: reread,
    onAttention: ({ hasUnread, streamPosition }) => {
      if (!hasUnread && litBy) {
        // The message that lit the dot here, next to the server's read: past it, it may be
        // missing from the answer and keeps the dot lit; where they cannot be compared, only a
        // read of the dot settles it.
        const lit = litBy.position;
        if (!streamPosition || !lit || streamPosition.epoch !== lit.epoch) {
          litBy = undefined;
          return reread();
        }
        if (streamPosition.offset < lit.offset) return;
      }
      if (!hasUnread) litBy = undefined;
      queryClient.setQueryData<ActivityNavAttention>(queryKey, (current) => ({
        hasUnread,
        streamPositions: streamPosition
          ? { [channel]: streamPosition }
          : (current?.streamPositions ?? {}),
      }));
    },
    // A message published after the dot was read but before the subscription started reaches it
    // only through a read.
    onSubscribed: (recovery) =>
      void rereadQueryMissedBySubscribe(queryClient, queryKey, channel, recovery, reread),
  };
}

type ActivityNavAttention = Awaited<ReturnType<typeof loadActivityNavAttention>>;
