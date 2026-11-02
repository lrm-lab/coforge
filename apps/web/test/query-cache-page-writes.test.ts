import { describe, expect, setSystemTime, test } from "bun:test";
import { AppError } from "#src/lib/app-error";

import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import { savedMessagesQuery } from "#src/features/conversations/conversation-queries";

import {
  memoryStore,
  settle,
  queryRows,
  pageLoad,
  gatedRead,
  channelKey,
  page,
  windowQuery,
  mount,
  dataBecomes,
  type Page,
} from "./helpers/query-cache-harness";

/**
 * What the page writes itself (realtime, a sent message, the sidebar's changes) is not stored:
 * only what a read of the server returned is, as TanStack's persister does (task #382).
 */
describe("what the page writes itself (realtime, a sent message, the sidebar's changes)", () => {
  /** Appends a message to the conversation's window the way a realtime event does. */
  const appendMessage = (queryClient: ReturnType<typeof pageLoad>["queryClient"], body: string) =>
    queryClient.setQueryData<{ pages: Page[]; pageParams: unknown[] }>(
      channelKey("c1"),
      (pages) =>
        pages && {
          ...pages,
          pages: [
            { ...pages.pages[0]!, messages: [...pages.pages[0]!.messages, { id: body, body }] },
          ],
        },
    );
  type Row = { state: { data: { pages: Page[] }; dataUpdatedAt: number } };
  const bodiesOf = (row: Row | undefined) => row?.state.data.pages[0]?.messages.map((m) => m.body);

  test("is not stored: the row keeps what the last read returned, and so does the next page load", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["read"])));
    await disk.written(1);
    const [key] = queryRows(disk.rows);
    const readRow = structuredClone(disk.rows.get(key!)) as Row;

    for (const body of ["realtime one", "realtime two", "my own"])
      appendMessage(load.queryClient, body);
    await settle();
    await settle();
    expect(disk.writes()).toBe(1);
    expect(disk.rows.get(key!)).toEqual(readRow);
    expect(bodiesOf(disk.rows.get(key!) as Row)).toEqual(["read"]);

    // The next page load opens at what the read returned, and then reads again.
    const after = pageLoad(disk.store);
    const network = gatedRead<Page>();
    const query = windowQuery("c1", network.read);
    const opened = await after.queryClient.ensureInfiniteQueryData(query);
    expect(opened.pages[0]?.messages.map((m) => m.body)).toEqual(["read"]);
    mount(after.queryClient, query);
    await network.started;
    network.release(page(["read", "arrived since"]));
    await dataBecomes<typeof opened>(
      after.queryClient,
      channelKey("c1"),
      (data) => data.pages[0]?.messages.some((m) => m.body === "arrived since") ?? false,
    );
  });

  test("never makes an old stored window look new", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["read"])));
    await disk.written(1);
    const [key] = queryRows(disk.rows);
    const readAt = (disk.rows.get(key!) as Row).state.dataUpdatedAt;

    setSystemTime(new Date(Date.now() + 60_000));
    try {
      appendMessage(load.queryClient, "realtime");
      await settle();
      await settle();
      expect((disk.rows.get(key!) as Row).state.dataUpdatedAt).toBe(readAt);
    } finally {
      setSystemTime();
    }
  });

  test("is not stored for the sidebar either", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const channels = { fetchedAt: 1, rows: [{ id: "general", name: "general", unread: 0 }] };
    load.queryClient.setQueryData(sidebarChannelsQueryKey("w1"), channels);
    load.queryClient.setQueryData(sidebarChannelsQueryKey("w1"), {
      ...channels,
      rows: [{ ...channels.rows[0]!, unread: 3 }],
    });
    await settle();
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });

  test("on a restored window is replaced by the server's page as a whole, and only that is stored", async () => {
    // Task #382: a channel stayed on its stored copy because a realtime message written into it
    // before the first read answered made the query look read.
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["stored one", "stored two"])),
    );
    await disk.written(1);

    const after = pageLoad(disk.store);
    const network = gatedRead<Page>();
    const query = windowQuery("c1", network.read);
    const opened = await after.queryClient.ensureInfiniteQueryData(query);
    expect(opened.pages[0]?.messages.map((m) => m.body)).toEqual(["stored one", "stored two"]);
    // The read of the server starts by itself, with no page mounting the query.
    await network.started;
    appendMessage(after.queryClient, "realtime");
    expect(after.queryClient.getQueryState(channelKey("c1"))?.isInvalidated).toBe(true);

    const server = page(["stored one", "stored two", "sent while the page was away"]);
    network.release(server);
    await dataBecomes<typeof opened>(
      after.queryClient,
      channelKey("c1"),
      (data) =>
        data.pages[0]?.messages.some((m) => m.body === "sent while the page was away") ?? false,
    );
    expect(after.queryClient.getQueryData<typeof opened>(channelKey("c1"))?.pages).toEqual([
      server,
    ]);
    expect(network.reads()).toBe(1);

    await disk.written(2);
    await settle();
    expect(disk.writes()).toBe(2);
    const [key] = queryRows(disk.rows);
    expect((disk.rows.get(key!) as Row).state.data.pages).toEqual([server]);
  });

  test("is stored on request, as the cache holds it then, for data no read of the server stands behind", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const names = { names: [{ id: "general" }], streamPositions: {} };
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), names);
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);

    await load.persistence.store(channelNamesQueryKey("w1"));
    expect(queryRows(disk.rows)).toEqual([
      'user-1/tanstack-query-["conversation","channel-names","w1"]',
    ]);
    const next = pageLoad(disk.store);
    const network = gatedRead<unknown>();
    const seen = await next.queryClient.ensureQueryData({
      queryKey: channelNamesQueryKey("w1"),
      queryFn: network.read,
    });
    expect(seen).toEqual(names);
  });

  test("keeps nothing a query nobody reviewed for storage holds, even on request", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    load.queryClient.setQueryData(["agent", "environment", "agent-1"], { API_KEY: "secret" });
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "general" }],
      streamPositions: {},
    });
    await load.persistence.store(["agent", "environment", "agent-1"]);
    await load.persistence.store(channelNamesQueryKey("w1"));
    await disk.written(1);
    await settle();
    expect(queryRows(disk.rows)).toEqual([
      'user-1/tanstack-query-["conversation","channel-names","w1"]',
    ]);
  });

  test("leaves the kept copy alone when the window on request is not one to open at", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["live end"])));
    await disk.written(1);
    // A jump to an old message replaces the window with one around it.
    load.queryClient.setQueryData(channelKey("c1"), {
      pages: [page(["around an old message"], { hasNewer: true })],
      pageParams: [undefined],
    });
    await load.persistence.store(channelKey("c1"));
    await settle();
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain(
      "live end",
    );
  });

  test("does not bring back a conversation the server said is gone meanwhile", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["read"])));
    await disk.written(1);
    appendMessage(load.queryClient, "realtime");
    // Its refetch answers NOT_FOUND, and the page drops it from memory.
    await load.queryClient
      .fetchInfiniteQuery({
        ...windowQuery("c1", async () => {
          throw new AppError("NOT_FOUND");
        }),
        staleTime: 0,
      })
      .catch(() => {});
    await disk.settled(() => queryRows(disk.rows).length === 0);
    load.queryClient.removeQueries({ queryKey: channelKey("c1"), exact: true });
    await load.persistence.store(channelKey("c1"));
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });

  test("does not keep a stand-in the page marked stale at once", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const saved = { streamPositions: {}, entries: [{ message: { id: "m1" } }] };
    await load.queryClient.fetchQuery({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: async () => saved,
    });
    await disk.written(1);
    // The Chat loader's stand-in when the Saved read failed: empty, and stale at once.
    load.queryClient.setQueryData(savedMessagesQuery("w1").queryKey, {
      streamPositions: {},
      entries: [],
    });
    await load.queryClient.invalidateQueries({
      queryKey: savedMessagesQuery("w1").queryKey,
      refetchType: "none",
    });
    await load.persistence.store(savedMessagesQuery("w1").queryKey);
    await settle();
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain('"m1"');
  });

  test("stores the newest state when the query was rebuilt meanwhile (a Workspace switch)", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "old" }],
      streamPositions: {},
    });
    load.queryClient.clear();
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "newest" }],
      streamPositions: {},
    });
    await load.persistence.store(channelNamesQueryKey("w1"));
    await disk.written(1);
    await settle();
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain(
      '"newest"',
    );
  });

  test("writes nothing once the page has signed out", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "general" }],
      streamPositions: {},
    });
    await load.persistence.purge();
    await load.persistence.store(channelNamesQueryKey("w1"));
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });
});
