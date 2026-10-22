import { expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";

import { mergeMessages } from "#src/features/conversations/conversation-messages";
import { conversationPages } from "#src/features/conversations/conversation-window-query";
import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
  CONVERSATION_WINDOW_SERVER_PAGE_LIMIT,
  foldWindowUpdates,
  windowPageFlags,
  type ConversationWindowCursor,
} from "#src/lib/conversation-window";

// A full refetch of the stream (window focus, an invalidation, a reconnect) re-reads every held
// page: the first from its own cursor, each later one forward from the page before it. Realtime
// messages are folded into the newest page, so it grows past a page's size; a refetch that read it
// back at that size stopped short of the tail, and the pane jumped to older history behind the
// "back to latest" button (task #65).

type Message = {
  id: string;
  sequence: number;
  senderKind: "user";
  senderName: string;
  body: string;
  createdAt: string;
};
type Page = { conversationId: string; hasOlder: boolean; hasNewer: boolean; messages: Message[] };
type Request = { beforeSequence?: number; afterSequence?: number; limit?: number };
type Window = InfiniteData<Page, ConversationWindowCursor>;

const message = (sequence: number): Message => ({
  id: `message-${sequence}`,
  sequence,
  senderKind: "user",
  senderName: "Frank",
  body: `message ${sequence}`,
  createdAt: "2026-10-22T10:00:00.000Z",
});

/** The conversation's top-level messages, and a page read over them the way the server reads one
 * (`public-channels.server.ts` `open`): at most 100 rows, one more taken to learn whether the page
 * overflowed, and `windowPageFlags` for the direction. Every request is recorded. */
function fakeServer(count: number) {
  const store = Array.from({ length: count }, (_, index) => message(index + 1));
  const requests: Request[] = [];
  const loadPage = async (request: Request): Promise<Page> => {
    requests.push(request);
    const limit = Math.min(request.limit ?? 50, 100);
    const forward = request.afterSequence !== undefined;
    const rows = forward
      ? store.filter((row) => row.sequence > request.afterSequence!).slice(0, limit + 1)
      : store
          .filter(
            (row) => request.beforeSequence === undefined || row.sequence < request.beforeSequence,
          )
          .slice(-(limit + 1))
          .reverse();
    const overflow = rows.length > limit;
    const page = rows.slice(0, limit).sort((left, right) => left.sequence - right.sequence);
    const direction = forward ? "forward" : request.beforeSequence ? "backward" : "initial";
    return { conversationId: "channel-1", ...windowPageFlags(direction, overflow), messages: page };
  };
  return { store, requests, loadPage };
}

const QUERY_KEY = ["conversation", "channel", "channel-1"];

function openWindow(server: ReturnType<typeof fakeServer>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { query } = conversationPages(QUERY_KEY, server.loadPage);
  const observer = new InfiniteQueryObserver(client, query);
  const window = () => client.getQueryData<Window>(QUERY_KEY)!;
  return { client, observer, window };
}

/** Folds newly sent messages into the newest page as the reconciler does
 * (`useConversationQuery`'s `mergeUpdates`), and adds them to the server's store. */
function receive(
  { client, window }: ReturnType<typeof openWindow>,
  server: ReturnType<typeof fakeServer>,
  count: number,
) {
  const next = server.store.length + 1;
  const arrived = Array.from({ length: count }, (_, index) => message(next + index));
  server.store.push(...arrived);
  const pages = window();
  const latest = pages.pages.at(-1)!;
  const fold = foldWindowUpdates(latest, [], arrived, mergeMessages);
  expect(fold?.messages).toBeDefined();
  client.setQueryData<Window>(QUERY_KEY, {
    ...pages,
    pages: [...pages.pages.slice(0, -1), { ...latest, messages: fold!.messages! }],
  });
}

const newestPage = (window: Window) => window.pages.at(-1)!;

test("a refetch after paging up keeps the live tail that realtime grew", async () => {
  const server = fakeServer(200);
  const opened = openWindow(server);
  await opened.client.fetchInfiniteQuery(conversationPages(QUERY_KEY, server.loadPage).query);
  await opened.observer.fetchPreviousPage();
  expect(opened.window().pages).toHaveLength(2);

  receive(opened, server, 7);
  const tail = newestPage(opened.window()).messages.at(-1)!;
  expect(tail.sequence).toBe(207);
  server.requests.length = 0;

  await opened.client.refetchQueries({ queryKey: QUERY_KEY });

  const after = newestPage(opened.window());
  expect(after.messages.at(-1)).toEqual(tail);
  expect(after.hasNewer).toBe(false);
  // Page 0 is re-read from its own cursor at the ordinary size; the forward page asks for the
  // server's maximum, so the walk reaches the tail again.
  expect(server.requests).toEqual([
    { beforeSequence: 181, afterSequence: undefined, limit: CONVERSATION_WINDOW_PAGE_SIZE },
    { beforeSequence: undefined, afterSequence: 180, limit: CONVERSATION_WINDOW_SERVER_PAGE_LIMIT },
  ]);
});

test("paging up or down asks for one ordinary page", async () => {
  const server = fakeServer(200);
  const opened = openWindow(server);
  await opened.client.fetchInfiniteQuery(conversationPages(QUERY_KEY, server.loadPage).query);
  // Enough pages of history that the window evicts its tail, so there is a newer page to fetch.
  for (let page = 0; page < CONVERSATION_WINDOW_MAX_PAGES; page++)
    await opened.observer.fetchPreviousPage();
  expect(newestPage(opened.window()).hasNewer).toBe(true);
  await opened.observer.fetchNextPage();

  expect(server.requests.map((request) => request.limit)).toEqual(
    Array(CONVERSATION_WINDOW_MAX_PAGES + 2).fill(CONVERSATION_WINDOW_PAGE_SIZE),
  );
  expect(server.requests.at(-1)?.afterSequence).toBeDefined();
});

test("a refetch of a window that is not at the tail keeps the ordinary page size", async () => {
  const server = fakeServer(200);
  const opened = openWindow(server);
  await opened.client.fetchInfiniteQuery(conversationPages(QUERY_KEY, server.loadPage).query);
  for (let page = 0; page < CONVERSATION_WINDOW_MAX_PAGES; page++)
    await opened.observer.fetchPreviousPage();
  const before = opened.window();
  expect(newestPage(before).hasNewer).toBe(true);
  server.requests.length = 0;

  await opened.client.refetchQueries({ queryKey: QUERY_KEY });

  // Realtime is buffered while the tail is evicted, and paging down flushes it, so the window
  // re-reads exactly what it held.
  expect(server.requests.map((request) => request.limit)).toEqual(
    Array(CONVERSATION_WINDOW_MAX_PAGES).fill(CONVERSATION_WINDOW_PAGE_SIZE),
  );
  expect(opened.window().pages.map((page) => page.messages.map((row) => row.sequence))).toEqual(
    before.pages.map((page) => page.messages.map((row) => row.sequence)),
  );
});
