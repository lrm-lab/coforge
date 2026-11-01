import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { PRELOAD_STALE_MS } from "#src/lib/preload-policy";
import { loadConversationOpen } from "./conversations.functions";

/**
 * Where the viewer's unread starts in a conversation, or in one thread of it, read once per open
 * (task #378). Never kept in the browser's storage (it is not in `persisted-queries.ts`), and
 * dropped when the open ends (`useConversationOpenRead`), so the next open reads it again; a page's
 * loader reads it ahead of the pane, which takes that read up. A failed read is retried on
 * TanStack's default backoff (doubling, up to 30s); offline it waits for the network.
 */
export const conversationOpenQuery = (conversationId: string, rootId?: string) =>
  queryOptions({
    // Not under `["conversation"]`, which profile and avatar changes invalidate whole: a pane still
    // waiting for its read must not take a later answer, read after the cursor moved.
    queryKey: ["conversation-open", conversationId, rootId ?? ""],
    queryFn: ({ signal }) =>
      loadConversationOpen({
        data: { conversationId, ...(rootId ? { threadRootId: rootId } : {}) },
        signal,
      }),
    // Read once per open; a cursor write marks it stale (`markOpenReadStale`), so the next open
    // (a pane mounting later, a loader) reads again while this one keeps what it froze.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A loader's read that no pane took up lasts as long as the router reuses that loader's
    // preload: a click on a card the pointer rested on opens on it, without a second read.
    gcTime: PRELOAD_STALE_MS,
    retry: true,
  });

/**
 * The read cursor moved, here or on another device: the open read no longer says where a next
 * open's unread starts. An open that observes it keeps what it froze, and the read is only marked
 * stale, for a next open to read again. One nobody observes (a loader's read ahead, still in flight
 * or answered, that a click within the router's preload reuse would open on) is dropped, so that
 * click reads afresh rather than draw a divider over messages read since (task #378).
 */
export function markOpenReadStale(
  queryClient: QueryClient,
  conversationId: string,
  rootId?: string,
) {
  const filters = { queryKey: conversationOpenQuery(conversationId, rootId).queryKey, exact: true };
  if (queryClient.getQueryCache().find(filters)?.isActive())
    void queryClient.invalidateQueries({ ...filters, refetchType: "none" });
  else queryClient.removeQueries(filters);
}
