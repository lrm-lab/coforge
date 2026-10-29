import { notifyManager, type Query, type QueryClient } from "@tanstack/react-query";

/**
 * The read that follows a restored query. A restored copy is only a first paint: the query is
 * marked invalidated, which is what TanStack's own stale check reads, so a page that shows it (now
 * or later) reads it again, whatever its `staleTime` says (the Chat lists never go stale on their
 * own), and the Chat loader's "marked stale" reads it too.
 *
 * Loading older or newer pages cancels that read (TanStack's `fetchPreviousPage` cancels a refetch
 * in flight) and its success clears the invalidation, which would leave the stored copy as the
 * newest page for good: such a query is invalidated again, until a read of the query itself
 * succeeds.
 */
export function followRestoredReads(queryClient: QueryClient) {
  /** Restored queries whose own read has not succeeded yet. */
  const awaitingRead = new Set<string>();
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    const { queryHash } = event.query;
    if (!awaitingRead.has(queryHash)) return;
    if (!event.query.state.fetchMeta?.fetchMore) {
      awaitingRead.delete(queryHash);
      return;
    }
    notifyManager.schedule(() => {
      void queryClient.invalidateQueries({ queryKey: event.query.queryKey, exact: true });
    });
  });
  return {
    /** `query` took its restored copy as its result (which clears the invalidation): mark it so
     * its own read follows. */
    restored(query: Query) {
      notifyManager.schedule(() => {
        awaitingRead.add(query.queryHash);
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
      });
    },
  };
}
