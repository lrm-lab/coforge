import { notifyManager, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";

/** How long a failed read of a restored query waits before it tries again: doubling from `firstMs`
 * up to `maxMs`, with jitter, as the conversation catch-up does (`RECONCILE_RETRY`). */
export const RESTORED_READ_RETRY = { firstMs: 1_000, maxMs: 30_000 };

/**
 * The read that follows a restored query. A restored copy is only a first paint: the query is
 * marked invalidated, which is what TanStack's own stale check reads, so a page that shows it (now
 * or later) reads it again, whatever its `staleTime` says (the Chat lists never go stale on their
 * own), and the Chat loader's "marked stale" reads it too.
 *
 * That read is retried until it succeeds (task #253). Queries do not retry (`retry: false`), and a
 * page opened from its stored copy hears none of the events that read a conversation again later
 * (the page coming back, the network returning): a phone just unlocked, whose first reads fail,
 * kept a week-old copy on screen as if it were the newest. A failure waits out
 * `RESTORED_READ_RETRY` and reads again while the page is visible (a hidden one reads on its
 * return: the invalidated query is stale to TanStack's focus refetch); the network returning
 * (`online`) or the page restored from the back-forward cache (`pageshow`, iOS Safari's usual way
 * back) reads again at once.
 *
 * Offline, TanStack does not fail such a read: it parks it (`fetchStatus: "paused"`) until the
 * network returns, so no failure is ever counted. A read that was parked is told apart (`paused`)
 * until it lands: it has not reached the newest messages either, and it resumes by itself once the
 * network is back, which is no sign yet that it will land.
 *
 * Loading older or newer pages cancels that read (TanStack's `fetchPreviousPage` cancels a refetch
 * in flight) and its success clears the invalidation, which would leave the stored copy as the
 * newest page for good: such a query is invalidated again, until a read of the query itself
 * succeeds.
 */
export function followRestoredReads(
  queryClient: QueryClient,
  {
    retry = RESTORED_READ_RETRY,
    random = Math.random,
    canRetry = () => typeof document === "undefined" || document.visibilityState === "visible",
    events = typeof window === "undefined" ? undefined : window,
  }: {
    retry?: typeof RESTORED_READ_RETRY;
    random?: () => number;
    canRetry?: () => boolean;
    /** Where `online` and `pageshow` are heard. */
    events?: Pick<Window, "addEventListener">;
  } = {},
) {
  /** Restored queries whose own read has not succeeded yet, with its failures in a row and whether
   * it waits for the network; `restoring` until that read is asked for (a success before it is the
   * restore's own, not a read). */
  const awaiting = new Map<
    string,
    {
      failures: number;
      paused?: boolean;
      restoring?: boolean;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const read = (queryKey: QueryKey) =>
    void queryClient.invalidateQueries({ queryKey, exact: true });
  const settle = (queryHash: string) => {
    const entry = awaiting.get(queryHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    awaiting.delete(queryHash);
    notify();
  };
  queryClient.getQueryCache().subscribe((event) => {
    const { queryHash } = event.query;
    if (event.type === "removed") return settle(queryHash);
    if (event.type !== "updated") return;
    const entry = awaiting.get(queryHash);
    if (!entry) return;
    if (!entry.paused && event.query.state.fetchStatus === "paused") {
      entry.paused = true;
      notify();
    }
    const { action } = event;
    if (action.type === "success" && !action.manual) {
      if (entry.restoring) return;
      // Settled in the batch that hands observers the new data: settled sooner, a render in
      // between would take the stored copy for the read.
      const fetchMore = event.query.state.fetchMeta?.fetchMore;
      notifyManager.schedule(() => {
        if (fetchMore) read(event.query.queryKey);
        else if (awaiting.get(queryHash) === entry && !entry.restoring) settle(queryHash);
      });
    } else if (action.type === "error") {
      entry.failures += 1;
      notify();
      clearTimeout(entry.timer);
      const delay = Math.min(retry.maxMs, retry.firstMs * 2 ** (entry.failures - 1));
      entry.timer = setTimeout(
        () => {
          entry.timer = undefined;
          if (canRetry()) read(event.query.queryKey);
        },
        delay * (0.5 + random() / 2),
      );
    }
  });
  const readAllNow = () => {
    for (const [queryHash, entry] of awaiting) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      const query = queryClient.getQueryCache().get(queryHash);
      // A parked read resumes by itself when the network returns; reading it again would cancel it
      // for a second request.
      if (query && query.state.fetchStatus !== "paused") read(query.queryKey);
    }
  };
  events?.addEventListener("online", readAllNow);
  events?.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) readAllNow();
  });
  return {
    /** `query` took its restored copy as its result (which clears the invalidation): mark it so
     * its own read follows. */
    restored(query: Query) {
      // Awaited from now, before the page renders the copy: it must not read as the newest.
      const entry = awaiting.get(query.queryHash) ?? { failures: 0 };
      entry.restoring = true;
      awaiting.set(query.queryHash, entry);
      notifyManager.schedule(() => {
        entry.restoring = false;
        read(query.queryKey);
      });
    },
    /** `query` was given data its caller read from the server (`setQueryData`): it no longer shows
     * its restored copy, so nothing waits for its own read, which still follows, unretried. */
    replaced(query: Query) {
      if (!awaiting.has(query.queryHash)) return;
      settle(query.queryHash);
      read(query.queryKey);
    },
    /** Whether the restored query `queryHash` is still waiting for a read of its own to succeed. */
    awaiting: (queryHash: string) => awaiting.has(queryHash),
    /** How many reads of the restored query `queryHash` failed in a row; 0 once one succeeded, or
     * for a query that was not restored. */
    failures: (queryHash: string) => awaiting.get(queryHash)?.failures ?? 0,
    /** Whether the read of the restored query `queryHash` was parked offline and has not landed
     * since. */
    paused: (queryHash: string) => awaiting.get(queryHash)?.paused ?? false,
    /** Called whenever `failures`, `paused` or `awaiting` may have changed. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
