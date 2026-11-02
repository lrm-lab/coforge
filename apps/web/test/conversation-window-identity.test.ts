import { expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";

import { mergeMessages } from "#src/features/conversations/conversation-messages";
import { conversationPages } from "#src/features/conversations/conversation-window-query";
import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
} from "#src/lib/conversation-window";
import {
  mapBrowserMessage,
  type BrowserMessageRow,
} from "#src/server/conversations/conversation-history.server";

// A re-read of a conversation's window (a refetch on focus or remount, an invalidation, a
// reconcile) hands the Query cache freshly decoded messages. TanStack Query's structural sharing
// keeps every message whose content did not change as the object already cached, so its memoized
// row does not render again; that only works on JSON-compatible values.

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const QUERY_KEY = ["conversation", "channel", "channel-1"];

type Message = ReturnType<typeof mapBrowserMessage>;
type Page = { conversationId: string; hasOlder: boolean; messages: Message[] };

function row(sequence: number, overrides: Partial<BrowserMessageRow> = {}): BrowserMessageRow {
  return {
    id: `message-${sequence}`,
    sequence,
    threadRootId: null,
    senderMemberId: "member-1",
    body: `message ${sequence}`,
    systemMessage: null,
    createdAt: new Date(`2026-09-17T10:0${sequence}:00Z`),
    sender: null,
    attachments: [],
    mentions: [],
    reactionVersion: 0,
    reactions: [],
    forward: null,
    ...overrides,
  };
}

/** What the server function returns for these rows: a fresh projection of freshly read rows (a
 * database read builds new `Date`s) every time. */
function read(rows: BrowserMessageRow[]): InfiniteData<Page, unknown> {
  return {
    pages: [
      {
        conversationId: "channel-1",
        hasOlder: false,
        messages: rows.map((message) =>
          mapBrowserMessage({ ...message, createdAt: new Date(message.createdAt) }, WORKSPACE_ID),
        ),
      },
    ],
    pageParams: [undefined],
  };
}

const messagesOf = (client: QueryClient) =>
  client.getQueryData<InfiniteData<Page, unknown>>(QUERY_KEY)!.pages[0]!.messages;

test("re-reading an unchanged window keeps every cached message object", () => {
  const client = new QueryClient();
  const rows = [row(1), row(2), row(3)];
  client.setQueryData(QUERY_KEY, read(rows));
  const before = messagesOf(client);

  client.setQueryData(QUERY_KEY, read(rows));

  const after = messagesOf(client);
  after.forEach((message, index) => expect(message).toBe(before[index]!));
});

test("a re-read gives a new object only to the message that changed", () => {
  const client = new QueryClient();
  client.setQueryData(QUERY_KEY, read([row(1), row(2), row(3)]));
  const before = messagesOf(client);

  client.setQueryData(
    QUERY_KEY,
    read([
      row(1),
      row(2, {
        reactions: [
          {
            emoji: "👍",
            member: {
              userId: "user-ada",
              agentId: null,
              agent: null,
              user: { username: "ada", displayName: "ada" },
            },
          },
        ],
      }),
      row(3),
    ]),
  );

  const after = messagesOf(client);
  expect(after[0]).toBe(before[0]!);
  expect(after[1]).not.toBe(before[1]!);
  expect(after[2]).toBe(before[2]!);
});

test("a reconcile that returns an already loaded message keeps its object", () => {
  const client = new QueryClient();
  const rows = [row(1), row(2), row(3)];
  client.setQueryData(QUERY_KEY, read(rows));
  const before = messagesOf(client);

  // What `mergeUpdates` writes: the loaded page with the reconciled messages folded in by id.
  const updates = read([rows[2]!]).pages[0]!.messages;
  client.setQueryData<InfiniteData<Page, unknown>>(QUERY_KEY, (window) => ({
    ...window!,
    pages: [{ ...window!.pages[0]!, messages: mergeMessages(window!.pages[0]!.messages, updates) }],
  }));

  expect(messagesOf(client)[2]).toBe(before[2]!);
});

// Paging adds a page at one end of the window, so every held page moves one place along. Structural
// sharing that compared the window page by page in place would set each held page against its
// neighbour and copy every message in it, and every loaded row would render again (task #427).

type Cursor = { before?: number; after?: number } | undefined;
type Window = InfiniteData<Page, Cursor>;

/** A conversation of `count` messages read the way the server pages it, each read decoding fresh
 * objects. */
function pagedWindow(count: number) {
  const store = Array.from({ length: count }, (_, index) =>
    row(index + 1, { createdAt: new Date(Date.UTC(2026, 8, 17, 10, index)) }),
  );
  const decode = (rows: BrowserMessageRow[]) =>
    rows.map((message) =>
      mapBrowserMessage({ ...message, createdAt: new Date(message.createdAt) }, WORKSPACE_ID),
    );
  const loadPage = async (request: {
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
  }) => {
    const limit = request.limit ?? CONVERSATION_WINDOW_PAGE_SIZE;
    const rows =
      request.afterSequence !== undefined
        ? store.filter((message) => message.sequence > request.afterSequence!).slice(0, limit)
        : store
            .filter(
              (message) =>
                request.beforeSequence === undefined || message.sequence < request.beforeSequence,
            )
            .slice(-limit);
    const first = rows[0]?.sequence ?? 1;
    const last = rows.at(-1)?.sequence ?? count;
    return {
      conversationId: "channel-1",
      hasOlder: first > 1,
      hasNewer: last < count,
      messages: decode(rows),
    };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const query = conversationPages<Message, Page & { hasNewer: boolean }>(QUERY_KEY, loadPage).query;
  const observer = new InfiniteQueryObserver(client, query);
  const loaded = () =>
    new Map(
      client
        .getQueryData<Window>(QUERY_KEY)!
        .pages.flatMap((page) => page.messages.map((message) => [message.id, message] as const)),
    );
  return { client, query, observer, loaded };
}

/** How many of `before`'s messages the window still holds as the very same object, of how many it
 * still holds at all. */
function kept(before: Map<string, Message>, after: Map<string, Message>) {
  const retained = [...after].filter(([id]) => before.has(id));
  return {
    same: retained.filter(([id, message]) => before.get(id) === message).length,
    retained: retained.length,
  };
}

test("paging up keeps every loaded message object", async () => {
  const window = pagedWindow(200);
  const unsubscribe = window.observer.subscribe(() => {});
  await window.client.fetchInfiniteQuery(window.query);
  await window.observer.fetchPreviousPage();
  const before = window.loaded();

  await window.observer.fetchPreviousPage();

  expect(kept(before, window.loaded())).toEqual({ same: 40, retained: 40 });
  unsubscribe();
});

test("paging up past the window's bound keeps the pages it retains", async () => {
  const window = pagedWindow(200);
  const unsubscribe = window.observer.subscribe(() => {});
  await window.client.fetchInfiniteQuery(window.query);
  for (let page = 1; page < CONVERSATION_WINDOW_MAX_PAGES; page++)
    await window.observer.fetchPreviousPage();
  const before = window.loaded();

  await window.observer.fetchPreviousPage();

  const retained = (CONVERSATION_WINDOW_MAX_PAGES - 1) * CONVERSATION_WINDOW_PAGE_SIZE;
  expect(kept(before, window.loaded())).toEqual({ same: retained, retained });
  unsubscribe();
});

test("paging back down keeps the pages it retains", async () => {
  const window = pagedWindow(200);
  const unsubscribe = window.observer.subscribe(() => {});
  await window.client.fetchInfiniteQuery(window.query);
  for (let page = 0; page < CONVERSATION_WINDOW_MAX_PAGES; page++)
    await window.observer.fetchPreviousPage();
  const before = window.loaded();

  await window.observer.fetchNextPage();

  const retained = (CONVERSATION_WINDOW_MAX_PAGES - 1) * CONVERSATION_WINDOW_PAGE_SIZE;
  expect(kept(before, window.loaded())).toEqual({ same: retained, retained });
  unsubscribe();
});

test("a re-read of an unchanged paged window keeps the whole window", async () => {
  const window = pagedWindow(200);
  const unsubscribe = window.observer.subscribe(() => {});
  await window.client.fetchInfiniteQuery(window.query);
  await window.observer.fetchPreviousPage();
  const before = window.client.getQueryData<Window>(QUERY_KEY);

  window.client.setQueryData<Window>(QUERY_KEY, (held) => ({
    pages: held!.pages.map((page) => ({
      ...page,
      messages: page.messages.map((message) => ({ ...message })),
    })),
    pageParams: [...held!.pageParams],
  }));

  expect(window.client.getQueryData<Window>(QUERY_KEY)).toBe(before);
  unsubscribe();
});

test("a message that changed on a moved page gets a new object, its neighbours do not", async () => {
  const window = pagedWindow(200);
  const unsubscribe = window.observer.subscribe(() => {});
  await window.client.fetchInfiniteQuery(window.query);
  await window.observer.fetchPreviousPage();
  const before = window.loaded();
  const changedId = "message-170";

  window.client.setQueryData<Window>(QUERY_KEY, (held) => ({
    ...held!,
    pages: [
      { ...held!.pages[0]!, messages: [] },
      ...held!.pages.map((page) => ({
        ...page,
        messages: page.messages.map((message) =>
          message.id === changedId ? { ...message, body: "edited" } : { ...message },
        ),
      })),
    ],
    pageParams: [undefined, ...held!.pageParams],
  }));

  const after = window.loaded();
  expect(after.get(changedId)).not.toBe(before.get(changedId)!);
  expect(after.get(changedId)?.body).toBe("edited");
  expect(kept(before, after)).toEqual({ same: 39, retained: 40 });
  unsubscribe();
});

test("a change to a page's own fields arrives, and its messages keep their objects", async () => {
  const window = pagedWindow(200);
  const unsubscribe = window.observer.subscribe(() => {});
  await window.client.fetchInfiniteQuery(window.query);
  await window.observer.fetchPreviousPage();
  const before = window.loaded();

  window.client.setQueryData<Window>(QUERY_KEY, (held) => ({
    ...held!,
    pages: held!.pages.map((page, index) => ({
      ...page,
      hasOlder: index === 0 ? false : page.hasOlder,
      messages: page.messages.map((message) => ({ ...message })),
    })),
  }));

  const after = window.client.getQueryData<Window>(QUERY_KEY)!;
  expect(after.pages[0]!.hasOlder).toBe(false);
  expect(kept(before, window.loaded())).toEqual({ same: 40, retained: 40 });
  unsubscribe();
});
