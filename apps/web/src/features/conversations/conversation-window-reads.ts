import { hashKey, type QueryClient } from "@tanstack/react-query";

/**
 * Calls `listener` with a query's data each time a network read of it succeeds, and not when the
 * page writes the data itself (`setQueryData` marks those `manual` in TanStack Query) or loads
 * more pages. Returns the unsubscribe.
 */
export function onNetworkRead<D>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  listener: (data: D) => void,
) {
  const queryHash = hashKey(queryKey);
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryHash !== queryHash) return;
    if (event.action.type !== "success" || event.action.manual) return;
    // Loading older or newer pages keeps the pages already held as they were: not a read of them.
    if (event.query.state.fetchMeta?.fetchMore) return;
    listener(event.action.data as D);
  });
}

/**
 * Waits until the window `queryKey` has no read of its own in flight. A read lands its answer over
 * whatever was written meanwhile, and a refetch walks the cursors it started from: a window
 * replaced with the one around a message while it ran (opening on a message in a stale window,
 * task #358) went back to the stale pages, without the message.
 */
export async function windowReadSettled(queryClient: QueryClient, queryKey: readonly unknown[]) {
  for (;;) {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (query?.state.fetchStatus !== "fetching" || !query.promise) return;
    await query.promise.catch(() => undefined);
  }
}
