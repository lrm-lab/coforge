import { expect, test } from "bun:test";
import { QueryClient, QueryObserver, notifyManager, onlineManager } from "@tanstack/react-query";

import { followRestoredReads } from "#src/features/cache-persistence/restored-reads";

const KEY = ["conversation", "channel", "c1"];
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shown query restored from storage whose network reads fail `failing` times, then succeed.
 * A failed read waits `retryMs` before it is tried again: long by default, so only a test about
 * the retry sees one. */
function setup({ failing = 0, visible = true, retryMs = 60_000 } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const listeners = new Map<string, (event: Event) => void>();
  const restoredReads = followRestoredReads(queryClient, {
    retry: { firstMs: retryMs, maxMs: retryMs * 4 },
    random: () => 1,
    canRetry: () => visible,
    events: { addEventListener: (type: string, listener: never) => listeners.set(type, listener) },
  });
  let reads = 0;
  queryClient.setQueryData(KEY, "stored copy");
  const observer = new QueryObserver(queryClient, {
    queryKey: KEY,
    queryFn: async () => {
      reads += 1;
      if (reads <= failing) throw new Error("network not ready");
      return "newest";
    },
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  restoredReads.restored(queryClient.getQueryCache().find({ queryKey: KEY })!);
  const queryHash = queryClient.getQueryCache().find({ queryKey: KEY })!.queryHash;
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
    reads: () => reads,
    data: () => queryClient.getQueryData(KEY),
    failures: () =>
      restoredReads.failures(queryClient.getQueryCache().find({ queryKey: KEY })!.queryHash),
    paused: () =>
      restoredReads.paused(queryClient.getQueryCache().find({ queryKey: KEY })!.queryHash),
    fire: (type: string, event: object = {}) => listeners.get(type)?.(event as Event),
    until,
    /** Its own read has landed: the follower let go of it. */
    landed: () => until(() => !restoredReads.awaiting(queryHash)),
    observer,
    unsubscribe,
  };
}

test("a restored query is read again, and the newest replaces the stored copy", async () => {
  const page = setup();
  await page.landed();
  expect(page.reads()).toBe(1);
  expect(page.data()).toBe("newest");
  expect(page.failures()).toBe(0);
});

test("a read lands for its subscribers no earlier than the page hears its data", async () => {
  const page = setup();
  // As `useQuery` hears it: in TanStack's next batch.
  let shown: unknown = "stored copy";
  page.observer.subscribe(
    notifyManager.batchCalls(() => (shown = page.observer.getCurrentResult().data)),
  );
  const { queryHash } = page.queryClient.getQueryCache().find({ queryKey: KEY })!;
  const shownWhenLanded: unknown[] = [];
  page.restoredReads.subscribe(() => {
    if (!page.restoredReads.awaiting(queryHash)) shownWhenLanded.push(shown);
  });
  await page.landed();
  expect(shownWhenLanded).toEqual(["newest"]);
});

test("a read that fails is tried again with backoff until one lands", async () => {
  const page = setup({ failing: 2, retryMs: 10 });
  await page.until(() => page.failures() === 1);
  expect(page.data()).toBe("stored copy");
  // The first retry waits 10 ms, the second 20 ms: at least that long, however slow the machine.
  let since = performance.now();
  await page.until(() => page.failures() === 2);
  expect(page.reads()).toBe(2);
  expect(performance.now() - since).toBeGreaterThanOrEqual(9);
  since = performance.now();
  await page.landed();
  expect(page.reads()).toBe(3);
  expect(performance.now() - since).toBeGreaterThanOrEqual(19);
  expect(page.data()).toBe("newest");
  expect(page.failures()).toBe(0);
});

test("the network back or the page restored from the back-forward cache reads again at once", async () => {
  const page = setup({ failing: 2 });
  await page.until(() => page.failures() === 1);
  page.fire("online");
  await page.until(() => page.failures() === 2);
  expect(page.reads()).toBe(2);
  // A `pageshow` that is a fresh load is not a way back.
  page.fire("pageshow", { persisted: false });
  await tick(2);
  expect(page.reads()).toBe(2);
  page.fire("pageshow", { persisted: true });
  await page.landed();
  expect(page.reads()).toBe(3);
  expect(page.data()).toBe("newest");
});

test("a hidden page does not retry by itself", async () => {
  const page = setup({ failing: 1, visible: false, retryMs: 10 });
  await page.until(() => page.failures() === 1);
  await tick(30);
  expect(page.reads()).toBe(1);
  expect(page.data()).toBe("stored copy");
});

test("a query read successfully once is no longer followed", async () => {
  const page = setup();
  await page.landed();
  page.fire("online");
  await tick(2);
  expect(page.reads()).toBe(1);
});

test("a restored query is awaited from the moment it is restored until its read lands", async () => {
  const page = setup();
  const hash = page.queryClient.getQueryCache().find({ queryKey: KEY })!.queryHash;
  let heard = 0;
  page.restoredReads.subscribe(() => (heard += 1));
  // Before the read is even asked for: the page renders the copy now, and must not take it as new.
  expect(page.restoredReads.awaiting(hash)).toBe(true);
  await page.landed();
  expect(page.data()).toBe("newest");
  expect(page.restoredReads.awaiting(hash)).toBe(false);
  // A read that lands at once is heard too, not only one that failed first.
  expect(heard).toBe(1);
});

test("offline, the read waits for the network and is told apart until it lands", async () => {
  // TanStack parks a read while offline rather than failing it: no failure is ever counted.
  onlineManager.setOnline(false);
  const page = setup({ failing: 1, retryMs: 10 });
  // As the app's provider does: the client hears the network come back.
  page.queryClient.mount();
  try {
    let changes = 0;
    page.restoredReads.subscribe(() => (changes += 1));
    await page.until(page.paused);
    expect(page.reads()).toBe(0);
    expect(page.failures()).toBe(0);
    expect(page.paused()).toBe(true);
    expect(changes).toBe(1);
    expect(page.data()).toBe("stored copy");

    // Back online, the first read fails: still not landed, so still told apart.
    onlineManager.setOnline(true);
    page.fire("online");
    await page.until(() => page.failures() === 1);
    expect(page.reads()).toBe(1);
    expect(page.paused()).toBe(true);

    // The retry lands: the follower lets go, and says so.
    const before = changes;
    await page.landed();
    expect(page.reads()).toBe(2);
    expect(page.data()).toBe("newest");
    expect(page.paused()).toBe(false);
    expect(changes).toBeGreaterThan(before);
  } finally {
    page.unsubscribe();
    page.queryClient.unmount();
    onlineManager.setOnline(true);
  }
});

test("a restored query given data read from the server is no longer awaited", async () => {
  // A conversation opened from Activity on its stored copy: the jump's own read of the window
  // replaces it (`setQueryData`), and the divider and the read cursor must not wait for another
  // (task #358). Before, only a read of the query itself ended the wait.
  const page = setup({ failing: 1 });
  const query = page.queryClient.getQueryCache().find({ queryKey: KEY })!;
  page.queryClient.setQueryData(KEY, "read around a message");
  expect(page.restoredReads.awaiting(query.queryHash)).toBe(true);
  page.restoredReads.replaced(query);
  expect(page.restoredReads.awaiting(query.queryHash)).toBe(false);
  // Its own read still follows, for what else the stored copy held.
  await page.until(() => page.data() === "newest");
  expect(page.data()).toBe("newest");
  page.unsubscribe();
});
