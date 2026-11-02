import { expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";

import { followRestoredReads } from "#src/features/cache-persistence/restored-reads";
import { AppError } from "#src/lib/app-error";

import { gatedRead } from "./helpers/query-cache-harness";

/**
 * A restored copy is only a first paint: the server's read follows it, and until one lands the
 * query stays stale, whatever the page writes into it meanwhile (task #382).
 */

const KEY = ["conversation", "channel", "c1"];

/** A query that takes its stored copy on its first read, as the persister hands it over, and reads
 * the server with `read` after that. */
function setup(read: () => Promise<string>, options?: Parameters<typeof followRestoredReads>[1]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const restoredReads = followRestoredReads(queryClient, options);
  const observer = new QueryObserver(queryClient, {
    queryKey: KEY,
    queryFn: read,
    staleTime: Infinity,
    persister: (queryFn, context, query) => {
      if (query.state.data !== undefined) return queryFn(context);
      restoredReads.restored(query);
      return Promise.resolve("stored copy");
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const query = () => queryClient.getQueryCache().find({ queryKey: KEY })!;
  /** Resolves once `check` holds, looked at again on each change the follower or the query
   * reports: waits for what the code does, not for a guess at how long it takes. */
  const until = (check: () => boolean) =>
    new Promise<void>((resolve) => {
      if (check()) return resolve();
      const look = () => {
        if (!check()) return;
        stopFollower();
        stopCache();
        resolve();
      };
      const stopFollower = restoredReads.subscribe(look);
      const stopCache = queryClient.getQueryCache().subscribe(look);
    });
  return {
    queryClient,
    restoredReads,
    observer,
    unsubscribe,
    query,
    data: () => queryClient.getQueryData(KEY),
    invalidated: () => query().state.isInvalidated,
    awaiting: () => restoredReads.awaiting(query().queryHash),
    until,
    /** The stored copy is on screen and still awaited. */
    restored: () => until(() => queryClient.getQueryData(KEY) === "stored copy"),
    /** Its own read has landed: the follower let go of it. */
    landed: () => until(() => !restoredReads.awaiting(query().queryHash)),
  };
}

test("a restored query is read again, and the newest replaces the stored copy", async () => {
  const network = gatedRead<string>();
  const page = setup(network.read);
  const heard: boolean[] = [];
  page.restoredReads.subscribe(() => heard.push(page.awaiting()));
  await page.restored();
  // The page renders the copy now, and must not take it as new.
  expect(page.awaiting()).toBe(true);
  await network.started;
  expect(page.data()).toBe("stored copy");
  network.release("newest");
  await page.landed();
  expect(page.data()).toBe("newest");
  expect(network.reads()).toBe(1);
  expect(page.invalidated()).toBe(false);
  expect(heard).toEqual([false]);
  page.unsubscribe();
});

test("a write of the page's own before the read answers does not cancel the read: the server's answer replaces everything", async () => {
  const network = gatedRead<string>();
  const page = setup(network.read);
  await page.restored();
  await network.started;

  // A realtime message arrives into the copy while the server is still being asked.
  page.queryClient.setQueryData(KEY, "stored copy and a realtime message");
  expect(page.data()).toBe("stored copy and a realtime message");
  // The write cleared the mark; the copy is still not the newest, so it is put back.
  expect(page.invalidated()).toBe(true);
  expect(page.awaiting()).toBe(true);

  network.release("newest");
  await page.landed();
  expect(page.data()).toBe("newest");
  expect(network.reads()).toBe(1);
  expect(page.invalidated()).toBe(false);
  page.unsubscribe();
});

test("a write of the page's own after a failed read leaves the query stale for the next read", async () => {
  let reads = 0;
  const page = setup(async () => {
    reads += 1;
    if (reads === 1) throw new Error("network not ready");
    return "newest";
  });
  await page.restored();
  await page.until(() => page.query().state.errorUpdateCount === 1);
  expect(page.awaiting()).toBe(true);

  page.queryClient.setQueryData(KEY, "stored copy and a realtime message");
  expect(page.invalidated()).toBe(true);
  // Whatever staleTime says, the next mount or refetch reads it.
  expect(page.observer.getCurrentResult().isStale).toBe(true);
  await page.queryClient.refetchQueries({ queryKey: KEY, stale: true });
  expect(reads).toBe(2);
  expect(page.data()).toBe("newest");
  expect(page.awaiting()).toBe(false);
  page.unsubscribe();
});

test("a query whose own read landed is no longer awaited, and later writes do not mark it", async () => {
  const page = setup(async () => "newest");
  await page.landed();
  expect(page.data()).toBe("newest");

  page.queryClient.setQueryData(KEY, "newest and a realtime message");
  expect(page.invalidated()).toBe(false);
  expect(page.awaiting()).toBe(false);
  page.unsubscribe();
});

test("a restored query given data read from the server is no longer awaited", async () => {
  // A conversation opened from Activity on its stored copy: the jump's own read of the window
  // replaces it (`setQueryData`), and the divider and the read cursor must not wait for another
  // (task #358).
  const network = gatedRead<string>();
  const page = setup(network.read);
  await page.restored();
  await network.started;

  page.queryClient.setQueryData(KEY, "read around a message");
  expect(page.awaiting()).toBe(true);
  page.restoredReads.replaced(page.query());
  expect(page.awaiting()).toBe(false);

  page.queryClient.setQueryData(KEY, "read around a message and a realtime one");
  expect(page.invalidated()).toBe(false);
  network.release("newest");
  await page.until(() => page.data() === "newest");
  page.unsubscribe();
});

test("loading an older page while the copy is awaited reads the query again", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const restoredReads = followRestoredReads(queryClient);
  /** The newest page's reads, each answered when the test says. */
  const heads: Array<(answer: string) => void> = [];
  const headAsked: Array<() => void> = [];
  const headsAsked = async (count: number) => {
    while (heads.length < count) await new Promise<void>((resolve) => headAsked.push(resolve));
  };
  const observer = new InfiniteQueryObserver<
    string,
    Error,
    { pages: string[] },
    typeof KEY,
    unknown
  >(queryClient, {
    queryKey: KEY,
    queryFn: ({ pageParam }) =>
      pageParam === "older"
        ? Promise.resolve("older")
        : new Promise<string>((resolve) => {
            heads.push(resolve);
            for (const asked of headAsked.splice(0)) asked();
          }),
    initialPageParam: undefined,
    getNextPageParam: (last) => (last === "older" ? undefined : "older"),
    staleTime: Infinity,
    persister: (queryFn, context, query) => {
      if (query.state.data !== undefined) return queryFn(context as never);
      restoredReads.restored(query);
      return Promise.resolve({ pages: ["stored copy"], pageParams: [undefined] }) as never;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const { queryHash } = queryClient.getQueryCache().find({ queryKey: KEY })!;
  await headsAsked(1);

  // The older page cancels the newest page's read that is under way.
  await observer.fetchNextPage();
  expect(restoredReads.awaiting(queryHash)).toBe(true);
  await headsAsked(2);
  for (const answer of heads) answer("newest");
  await new Promise<void>((resolve) => {
    const stop = restoredReads.subscribe(() => {
      if (restoredReads.awaiting(queryHash)) return;
      stop();
      resolve();
    });
  });
  expect(queryClient.getQueryData<{ pages: string[] }>(KEY)?.pages).toContain("newest");
  unsubscribe();
});

/** A read of the server that fails `failing` times, then answers "newest". */
function flaky(failing: number, error: () => Error = () => new Error("network not ready")) {
  let reads = 0;
  return {
    reads: () => reads,
    read: async () => {
      reads += 1;
      if (reads <= failing) throw error();
      return "newest";
    },
  };
}

const FAST_RETRY = { firstMs: 5, maxMs: 20 };

test("a restored read that fails is tried again by itself until one lands, though queries do not retry", async () => {
  const network = flaky(2);
  const page = setup(network.read, { retry: FAST_RETRY, visible: () => true });
  await page.landed();
  expect(page.data()).toBe("newest");
  expect(network.reads()).toBe(3);
  expect(page.invalidated()).toBe(false);
  page.unsubscribe();
});

test("a hidden page does not try again by itself: the stale copy is read when it comes back", async () => {
  const network = flaky(1);
  const page = setup(network.read, { retry: FAST_RETRY, visible: () => false });
  await page.until(() => network.reads() === 1 && page.query().state.status === "error");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(network.reads()).toBe(1);
  expect(page.awaiting()).toBe(true);
  expect(page.invalidated()).toBe(true);
  page.unsubscribe();
});

test("a conversation the server says is gone is not read again", async () => {
  const network = flaky(1, () => new AppError("NOT_FOUND"));
  const page = setup(network.read, { retry: FAST_RETRY, visible: () => true });
  await page.until(() => network.reads() === 1 && page.query().state.status === "error");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(network.reads()).toBe(1);
  page.unsubscribe();
});
