import { InfiniteQueryObserver, QueryClient, infiniteQueryOptions } from "@tanstack/react-query";

import {
  installQueryCachePersistence,
  type PersistedQueryStore,
} from "#src/features/cache-persistence/query-cache-persistence";

/**
 * Page loads over a store in memory, for the tests of the browser's copy of the Query cache: a
 * QueryClient per "page load", with the network held open by a gate.
 */

/** A store in memory that tells when a change has landed, so a test waits on that and not on time. */
export function memoryStore() {
  const rows = new Map<string, unknown>();
  const changes: Array<() => void> = [];
  let writeCount = 0;
  const changed = () => {
    for (const waiter of changes.splice(0)) waiter();
  };
  const store: PersistedQueryStore = {
    get: async (key) => rows.get(key),
    set: async (key, value) => {
      rows.set(key, value);
      // A query's row, not the bookkeeping beside it (who owns the store, when it was swept).
      if (key.includes("tanstack-query-")) writeCount += 1;
      changed();
    },
    delete: async (key) => {
      rows.delete(key);
      changed();
    },
    keys: async () => [...rows.keys()],
    entries: async () => [...rows.entries()],
    clear: async () => rows.clear(),
  };
  const untilRows = async (done: () => boolean) => {
    while (!done()) await new Promise<void>((resolve) => changes.push(resolve));
  };
  return {
    store,
    rows,
    /** How many query rows have been written in all. */
    writes: () => writeCount,
    /** Resolves once `count` query rows in all have been written. */
    written: (count: number) => untilRows(() => writeCount >= count),
    /** Resolves once the rows are as `done` says. */
    settled: untilRows,
  };
}

/** Lets every pending storage step run: the store in memory answers within one task. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The query rows in storage, without the bookkeeping beside them. */
export const queryRows = (rows: Map<string, unknown>) =>
  [...rows.keys()].filter((key) => key.includes("tanstack-query-"));

/** A page load: a fresh QueryClient (an empty memory) over the storage that outlives it. */
export function pageLoad(
  store: PersistedQueryStore,
  { viewerId = "user-1" as string | null } = {},
) {
  // The app's own defaults (`router.tsx`): a read is fresh for 30 s.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
  const persistence = installQueryCachePersistence(queryClient, {
    store,
    viewerId: () => viewerId ?? undefined,
  });
  return { queryClient, persistence };
}

/** A network read that answers only when the test lets it. */
export function gatedRead<T>() {
  let release: (value: T) => void = () => {};
  const answer = new Promise<T>((resolve) => (release = resolve));
  let reads = 0;
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => (begin = resolve));
  return {
    read: () => {
      reads += 1;
      begin();
      return answer;
    },
    release,
    /** Resolves when the read has been asked for. */
    started,
    reads: () => reads,
  };
}

export const channelKey = (id: string) => ["conversation", "channel", id] as const;
export type Page = {
  conversationId: string;
  messages: { id: string; body: string }[];
  hasNewer?: boolean;
};
export const page = (messages: string[], fields: Partial<Page> = {}): Page => ({
  conversationId: "c1",
  messages: messages.map((body, index) => ({ id: `m${index}`, body })),
  ...fields,
});
export const windowQuery = (
  id: string,
  read: (context: { signal: AbortSignal }) => Promise<Page>,
) =>
  infiniteQueryOptions({
    queryKey: channelKey(id),
    queryFn: (context) => read(context),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: () => undefined,
  });

/** What a component does with a query: observes it, which reads it again when it is stale. */
export function mount(queryClient: QueryClient, options: ReturnType<typeof windowQuery>) {
  return new InfiniteQueryObserver(queryClient, options).subscribe(() => {});
}

/** Resolves when the query's state satisfies `matches`. */
export function queryBecomes(
  queryClient: QueryClient,
  key: readonly unknown[],
  matches: (state: { status: string }) => boolean,
) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const state = queryClient.getQueryState(key);
      if (state && matches(state)) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

/** Resolves when the query's data satisfies `matches`, however it got there. */
export function dataBecomes<T>(
  queryClient: QueryClient,
  key: readonly unknown[],
  matches: (d: T) => boolean,
) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const data = queryClient.getQueryData<T>(key);
      if (data !== undefined && matches(data)) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}
