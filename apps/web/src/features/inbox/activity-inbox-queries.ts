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

/** Every cached page of every view shares this prefix, so one invalidation refreshes them all. */
export const ACTIVITY_INBOX_QUERY_PREFIX = ["activity-inbox"] as const;

/** Every paged list view, and nothing else under the prefix (the nav dot is not paged). */
export const ACTIVITY_INBOX_LISTS_KEY = [...ACTIVITY_INBOX_QUERY_PREFIX, "list"] as const;

/** One view of the viewer's Activity inbox, each page after the last item of the one before. */
export const activityInboxQuery = (workspaceId: string, filter: ActivityInboxFilter) =>
  infiniteQueryOptions({
    queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId, filter],
    queryFn: ({ pageParam }) => loadActivityInbox({ data: { filter, cursor: pageParam } }),
    initialPageParam: undefined as ActivityInboxCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    structuralSharing: (held: unknown, next: unknown) =>
      replaceEqualDeep(held, keepLaterFirstPage(held as ReadPages, next as ReadPages)),
  });

/** A read that knows where it stood in the viewer's channels. */
type StreamRead = { streamPositions: StreamPositions };
type ReadPages = InfiniteData<StreamRead> | undefined;

/**
 * The list's first page is read again on its own for a new message (the view's
 * `refreshFirstPage`), while a read of the list may be under way: the next page as the viewer
 * scrolls, or every page again. That read started from the pages held then and writes them back
 * when it ends, which would put the first page from before the message back. Whatever writes the
 * list, a first page read earlier than the one held keeps the held one.
 */
export function keepLaterFirstPage<Data extends ReadPages>(held: Data, next: Data): Data {
  const kept = held?.pages[0];
  const incoming = next?.pages[0];
  if (!next || !kept || !incoming || !readEarlier(incoming, kept)) return next;
  return { ...next, pages: [kept, ...next.pages.slice(1)] };
}

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

/** Every workspace's "Waiting on you" list. Apart from the inbox's prefix: reading or finishing an
 * item cannot change which cards wait, so those refreshes leave it be. */
export const WAITING_CHOICE_CARDS_KEY = ["waiting-choice-cards"] as const;

/** The choice cards waiting on the viewer, for Activity's first section. The server announces a
 * card posted, answered or withdrawn to the person it asks as an Activity change. */
export const waitingChoiceCardsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: [...WAITING_CHOICE_CARDS_KEY, workspaceId],
    queryFn: () => loadWaitingChoiceCards(),
  });

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
function readEarlier(answer: StreamRead, than: StreamRead) {
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
 * when the two places cannot be compared, the dot reads again. A read that leaves a conversation
 * read re-reads a lit dot. Any other `activity.changed.v1` (a mention from outside the channel, a
 * Task assignment) says nothing of which way it went, so it re-reads.
 */
export function activityNavAttentionRealtime(
  queryClient: QueryClient,
  userId: string,
): {
  onMessage: (event: unknown, position: StreamPosition | undefined) => void;
  onActivity: () => void;
  onAttention: (attention: ActivityAttention) => void;
  onSubscribed: (recovery: SubscribedRecovery) => void;
  onRead: () => void;
} {
  const queryKey = activityNavAttentionQuery().queryKey;
  const channel = userConversationChannel(userId);
  // The newest message that lit the dot here, by where it stands in the viewer's channel.
  let litBy: { position: StreamPosition | undefined } | undefined;
  // A message that lights the dot while a read is under way may be missing from its answer, so
  // that answer cannot put it out.
  const reread = () => {
    const before = litBy;
    void queryClient.invalidateQueries({ queryKey }).then(() => {
      if (litBy === before) return;
      queryClient.setQueryData<ActivityNavAttention>(
        queryKey,
        (current) => current && { ...current, hasUnread: true },
      );
    });
  };
  return {
    // The read's stream positions stay: a message delivered here moved the dot without a read.
    onMessage: (event, position) => {
      // A muted conversation's message counts on its own row only.
      if ((event as { muted?: true } | undefined)?.muted) return;
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
    // A read in an open conversation moves no Activity write, so it says nothing of the dot; when
    // it leaves that conversation read and the dot is lit (perhaps by a message read since), only
    // a read of the dot settles it.
    onRead: () => {
      if (queryClient.getQueryData<ActivityNavAttention>(queryKey)?.hasUnread) reread();
    },
    // A message published after the dot was read but before the subscription started reaches it
    // only through a read.
    onSubscribed: (recovery) =>
      void rereadQueryMissedBySubscribe(queryClient, queryKey, channel, recovery, reread),
  };
}

type ActivityNavAttention = Awaited<ReturnType<typeof loadActivityNavAttention>>;
