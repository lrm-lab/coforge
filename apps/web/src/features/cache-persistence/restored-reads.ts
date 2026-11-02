import type { Query, QueryClient } from "@tanstack/react-query";

/**
 * A restored copy is only a first paint: the server's read of the query follows at once and
 * replaces it, as TanStack's own `refetchOnRestore` does
 * ([docs](https://tanstack.com/query/latest/docs/framework/react/plugins/createPersister)).
 * That option is the persister's, for every kept query, so it would also "read" a Computer's
 * Agent workspace scan, whose read is no read of the server (`readsAfterRestore`); the read is
 * started here instead, for the queries that have one.
 *
 * Until a read of its own lands, the copy also stays stale to TanStack, so any later trigger reads
 * it (a page mounting it, the window regaining focus, the network returning), whatever its
 * `staleTime`. That is not TanStack's: a write of the page's own (`setQueryData`: a realtime
 * message, a read position) or a page of older messages loaded meanwhile counts as a success and
 * clears the mark, and a read cancelled by them or by the last page showing it going away would
 * then leave the copy as the newest (task #382: a channel stayed on its stored copy of 10-21). So
 * the mark is put back whatever cleared it, and loading older pages, which cancels the read in
 * flight, reads it again.
 */
export function followRestoredReads(queryClient: QueryClient) {
  /** Restored queries whose own read has not landed yet. */
  const awaiting = new Set<string>();
  /** Of those, the ones whose restore has not been handed to them yet: its success is the copy. */
  const restoring = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const read = (query: Query) => void query.fetch().catch(() => {});
  queryClient.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (event.type === "removed") {
      restoring.delete(query.queryHash);
      if (awaiting.delete(query.queryHash)) notify();
      return;
    }
    if (event.type !== "updated" || !awaiting.has(query.queryHash)) return;
    const { action } = event;
    if (action.type === "success" && !action.manual && restoring.delete(query.queryHash)) {
      query.invalidate();
      return;
    }
    if (action.type === "success" && !action.manual) {
      if (query.state.fetchMeta?.fetchMore) {
        query.invalidate();
        read(query);
        return;
      }
      awaiting.delete(query.queryHash);
      notify();
      return;
    }
    // A write of the page's own, or a read cancelled back to such a write: still the copy.
    if (!query.state.isInvalidated) query.invalidate();
  });
  return {
    /** `query` took its restored copy as its result: read it now, and keep it stale until then. */
    restored(query: Query) {
      awaiting.add(query.queryHash);
      restoring.add(query.queryHash);
      notify();
      // The restore resolves inside the query's own read: start the next one once it has settled.
      setTimeout(() => read(query), 0);
    },
    /** `query` was given data its caller read from the server (`setQueryData`): its copy is gone. */
    replaced(query: Query) {
      if (awaiting.delete(query.queryHash)) notify();
    },
    /** Whether the restored query `queryHash` still shows its copy: no read of its own landed. */
    awaiting: (queryHash: string) => awaiting.has(queryHash),
    /** Called whenever `awaiting` may have changed. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
