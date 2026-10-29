import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { followRestoredReads } from "#src/features/cache-persistence/restored-reads";

const KEY = ["conversation", "channel", "c1"];
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shown query restored from storage whose network reads fail `failing` times, then succeed. */
function setup({ failing = 0, visible = true } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const listeners = new Map<string, (event: Event) => void>();
  const restoredReads = followRestoredReads(queryClient, {
    retry: { firstMs: 10, maxMs: 40 },
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
  return {
    queryClient,
    restoredReads,
    reads: () => reads,
    data: () => queryClient.getQueryData(KEY),
    failures: () =>
      restoredReads.failures(queryClient.getQueryCache().find({ queryKey: KEY })!.queryHash),
    fire: (type: string, event: object = {}) => listeners.get(type)?.(event as Event),
    unsubscribe,
  };
}

test("a restored query is read again, and the newest replaces the stored copy", async () => {
  const page = setup();
  await tick(5);
  expect(page.reads()).toBe(1);
  expect(page.data()).toBe("newest");
  expect(page.failures()).toBe(0);
});

test("a read that fails is tried again with backoff until one lands", async () => {
  const page = setup({ failing: 2 });
  await tick(5);
  expect(page.data()).toBe("stored copy");
  expect(page.failures()).toBe(1);
  // The first retry waits 10 ms, the second 20 ms.
  await tick(15);
  expect(page.reads()).toBe(2);
  expect(page.failures()).toBe(2);
  await tick(25);
  expect(page.reads()).toBe(3);
  expect(page.data()).toBe("newest");
  expect(page.failures()).toBe(0);
});

test("the network back or the page restored from the back-forward cache reads again at once", async () => {
  const page = setup({ failing: 2 });
  await tick(5);
  expect(page.reads()).toBe(1);
  page.fire("online");
  await tick(2);
  expect(page.reads()).toBe(2);
  // A `pageshow` that is a fresh load is not a way back.
  page.fire("pageshow", { persisted: false });
  await tick(2);
  expect(page.reads()).toBe(2);
  page.fire("pageshow", { persisted: true });
  await tick(2);
  expect(page.reads()).toBe(3);
  expect(page.data()).toBe("newest");
});

test("a hidden page does not retry by itself", async () => {
  const page = setup({ failing: 1, visible: false });
  await tick(30);
  expect(page.reads()).toBe(1);
  expect(page.data()).toBe("stored copy");
});

test("a query read successfully once is no longer followed", async () => {
  const page = setup();
  await tick(5);
  page.fire("online");
  await tick(2);
  expect(page.reads()).toBe(1);
});
