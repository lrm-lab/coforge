import { afterEach, describe, expect, test } from "bun:test";
import { onlineManager } from "@tanstack/react-query";

import { publicChannelQuery } from "#src/features/conversations/conversation-queries";
import {
  channelKey,
  dataBecomes,
  memoryStore,
  mount,
  page,
  pageLoad,
  queryBecomes,
  settle,
  windowQuery,
  type Page,
} from "./helpers/query-cache-harness";

/**
 * A conversation opened from the browser's stored copy while the browser is offline (task #253):
 * the restore runs inside the read, so how the read waits for the network decides whether the copy
 * is looked at at all.
 */

describe("a conversation opened offline, after a page load that held nothing of it", () => {
  afterEach(() => onlineManager.setOnline(true));
  /** The network as the browser has it: unreachable while offline. */
  const network = (body: string) => () =>
    onlineManager.isOnline()
      ? Promise.resolve(page([body]))
      : Promise.reject(new TypeError("Failed to fetch"));
  // The network options the real conversation windows read with (task #253).
  const { networkMode, retry, retryDelay } = publicChannelQuery("c1").query;
  const realWindow = (read: () => Promise<Page>) => ({
    ...windowQuery("c1", read),
    networkMode,
    retry,
    retryDelay,
  });

  test("opens from its stored copy, and its read waits for the network, then lands", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["stored"])));
    await disk.written(1);

    onlineManager.setOnline(false);
    const after = pageLoad(disk.store);
    // As `QueryClientProvider` does: the client hears the network return.
    after.queryClient.mount();
    const read = realWindow(network("newest"));
    const opened = await after.queryClient.ensureInfiniteQueryData(read);
    expect(opened.pages[0]!.messages.map((m) => m.body)).toEqual(["stored"]);

    // The read that follows the copy fails offline and is parked, which the stream says.
    const unmount = mount(after.queryClient, read);
    await queryBecomes(
      after.queryClient,
      channelKey("c1"),
      (state) => (state as { fetchStatus?: string }).fetchStatus === "paused",
    );
    expect(after.persistence.restoredReadPaused(channelKey("c1"))).toBe(true);

    onlineManager.setOnline(true);
    await dataBecomes<{ pages: Page[] }>(
      after.queryClient,
      channelKey("c1"),
      (data) => data.pages[0]!.messages[0]!.body === "newest",
    );
    // The read lands in the batch that hands the page its data.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(after.persistence.restoredReadPaused(channelKey("c1"))).toBe(false);
    unmount();
    after.queryClient.unmount();
  });

  test("in the app's default network mode the read is parked before the copy is looked at", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["stored"])));
    await disk.written(1);

    onlineManager.setOnline(false);
    const after = pageLoad(disk.store);
    let opened = false;
    void after.queryClient
      .ensureInfiniteQueryData(windowQuery("c1", network("newest")))
      .then(() => (opened = true));
    await settle();
    await settle();
    // Why the window sets its own mode: this is the skeleton QA saw.
    expect(opened).toBe(false);
  });
});
