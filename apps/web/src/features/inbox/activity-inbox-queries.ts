import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

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
 * query prefix, so every list refresh also refreshes the dot. */
export const activityNavAttentionQuery = () =>
  queryOptions({
    queryKey: [...ACTIVITY_INBOX_QUERY_PREFIX, "nav-attention"],
    queryFn: () => loadActivityNavAttention(),
    staleTime: 30_000,
  });
