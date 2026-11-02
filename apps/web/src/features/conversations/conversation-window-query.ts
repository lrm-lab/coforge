// The stream's TanStack infinite query: a conversation's bounded window of pages, and the size and
// cursor each page is read with (the window's rules are in `lib/conversation-window.ts`).
import {
  infiniteQueryOptions,
  onlineManager,
  replaceEqualDeep,
  type InfiniteData,
} from "@tanstack/react-query";

import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
  nextPageCursor,
  previousPageCursor,
  windowPageLimit,
  type ConversationWindowCursor,
} from "#src/lib/conversation-window";
import { isAppErrorCode } from "#src/lib/app-error";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import type { ReactionSummary } from "./message-reactions";
import type { ThreadReplyInput, WindowThreadsPage } from "./thread-summary-model";

/** Retries of a failed window read while online: 1 + 2 + 4 seconds, then the page says it could not
 * load the newest messages (`ConversationUpdateNotice`) and the next focus or reconnect reads it. */
const WINDOW_READ_RETRIES = 3;
export type PageMessage = ThreadReplyInput & {
  threadRootId?: string;
  actionCard?: ActionCardView;
  reactions?: ReactionSummary[];
};
export type ConversationPage<M extends PageMessage> = WindowThreadsPage & {
  conversationId: string;
  /** The viewer's member row in the conversation; empty for someone who never joined or left. */
  senderMemberId?: string;
  /** How far the furthest-reading other member (a person or an Agent) has read the top-level
   * messages: the viewer's own messages up to it show as read. */
  othersReadThroughSequence?: number;
  hasOlder: boolean;
  hasNewer?: boolean;
  /** Top-level messages only: a thread's replies are read when its pane opens
   * (`conversationThreadQuery`), and the page holds its summary (`threads`). */
  messages: M[];
};

/** One page request: an initial load (no cursor), an older page, or a newer page. */
type PageRequest = {
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
};

/** The query observer's live reading-position signal; absent for loader-only initial reads. */
type ConversationPageQueryMeta = { conversationFollowingLatest?: () => boolean };

/** The oldest loaded message bounds the next page of history (a page holds top-level messages). */
const beforeFirstMessage = (messages: PageMessage[]) => messages[0]?.sequence;

export function conversationPages<M extends PageMessage, T extends ConversationPage<M>>(
  queryKey: readonly unknown[],
  loadPage: (page: PageRequest, signal?: AbortSignal) => Promise<T>,
) {
  // The bounded window: `maxPages` keeps the loaded pages from growing with every page of history
  // read, dropping the page at the far end from the fetch (see `lib/conversation-window.ts`).
  const query = infiniteQueryOptions({
    queryKey,
    queryFn: ({ client, queryKey, pageParam, meta, signal }) => {
      const cursor = pageParam as ConversationWindowCursor;
      // While a fetch runs, the query's state still holds the window from before it, and its
      // `fetchMeta` already says whether this is a page more (`fetchMore`) or a full refetch.
      const held = client.getQueryState<InfiniteData<T>>(queryKey);
      const fullRefetch = !held?.fetchMeta?.fetchMore;
      const windowAtTail = !held?.data?.pages.at(-1)?.hasNewer;
      const followingLatest =
        (meta as ConversationPageQueryMeta | undefined)?.conversationFollowingLatest?.() ?? true;
      // A full refetch otherwise walks forward from the oldest retained page only as many times as
      // there were pages before it. No finite page limit can guarantee that walk reaches a live
      // tail that realtime has grown without bound. Restart from the uncursored newest page only
      // while the viewport is following it; an active reader keeps the retained cursors and rows.
      const requestCursor = fullRefetch && windowAtTail && followingLatest ? undefined : cursor;
      return loadPage(
        {
          beforeSequence: requestCursor?.before,
          afterSequence: requestCursor?.after,
          limit: windowPageLimit({
            forward: requestCursor?.after !== undefined,
            fullRefetch,
            windowAtTail,
          }),
        },
        signal,
      );
    },
    initialPageParam: undefined as ConversationWindowCursor,
    maxPages: CONVERSATION_WINDOW_MAX_PAGES,
    structuralSharing: shareWindowPages,
    // The window opens from the browser's stored copy, and that restore runs inside the read (the
    // persister wraps `queryFn`). The app's `online` mode parks a read offline before it starts,
    // so a page reloaded and then cut off never looked at the copy and stayed on its skeleton
    // (task #253). `offlineFirst` runs the read once whatever the network, which serves the copy.
    // TanStack parks only a retry: a read that fails offline is retried at once, which parks it
    // until the network returns, as `online` did. Online, a failed read is retried with TanStack's
    // own backoff (a phone just unlocked fails its first reads, task #253), but not a conversation
    // the server says is gone.
    networkMode: "offlineFirst",
    retry: (failures, error) =>
      !onlineManager.isOnline() ||
      (failures < WINDOW_READ_RETRIES && !isAppErrorCode(error, "NOT_FOUND")),
    retryDelay: (failures) =>
      onlineManager.isOnline() ? Math.min(1000 * 2 ** failures, 30_000) : 0,
    // Pages[0] is the oldest loaded window, the latest is the live end. Each direction derives its
    // cursor from the boundary page, and an honest `hasNewer` tells whether the newest retained page
    // is still the tail.
    getPreviousPageParam: (oldest: T) =>
      previousPageCursor(oldest, beforeFirstMessage(oldest.messages)),
    getNextPageParam: (newest: T) => nextPageCursor(newest, newest.messages.at(-1)?.sequence),
  });
  /** The newest page on its own, for returning to the live end after the window slid up into
   * history and evicted the tail. */
  const loadInitialPage = () => loadPage({ limit: CONVERSATION_WINDOW_PAGE_SIZE });
  return { query, loadInitialPage };
}

type WindowData = { pages: Array<{ messages: Array<{ id: string }> }>; pageParams: unknown[] };

const isWindowData = (data: unknown): data is WindowData =>
  typeof data === "object" &&
  data !== null &&
  Array.isArray((data as WindowData).pages) &&
  Array.isArray((data as WindowData).pageParams) &&
  (data as WindowData).pages.every((page) => Array.isArray(page?.messages));

type WindowPage = WindowData["pages"][number];

const sameItems = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * The window's structural sharing: TanStack's default (`replaceEqualDeep`), but matched by message
 * id and by page rather than by index. Paging adds a page at one end, so every held page moves one
 * place along; compared in place, each would be set against its neighbour and every message in it
 * copied, and every memoized row would render again on each page of history (task #427). Each
 * message is compared with the held message of its id, and each page's other fields with the held
 * page that held its first message; a message or page the window did not hold is kept as read.
 */
function shareWindowPages(held: unknown, next: unknown): unknown {
  if (!isWindowData(held) || !isWindowData(next)) return replaceEqualDeep(held, next);
  const heldMessage = new Map<string, unknown>();
  const heldPageOf = new Map<string, WindowPage>();
  for (const page of held.pages)
    for (const message of page.messages) {
      heldMessage.set(message.id, message);
      heldPageOf.set(message.id, page);
    }
  const pages = next.pages.map((page, index): WindowPage => {
    const messages = page.messages.map((message) =>
      replaceEqualDeep(heldMessage.get(message.id), message),
    );
    const first = page.messages[0];
    // An empty page (an empty conversation) can only be matched by its place.
    const counterpart = first ? heldPageOf.get(first.id) : held.pages[index];
    if (!counterpart || (!first && counterpart.messages.length > 0))
      return sameItems(messages, page.messages) ? page : { ...page, messages };
    const { messages: heldMessages, ...heldRest } = counterpart;
    const { messages: _read, ...nextRest } = page;
    const rest = replaceEqualDeep(heldRest, nextRest);
    const sharedMessages = sameItems(messages, heldMessages) ? heldMessages : messages;
    return rest === heldRest && sharedMessages === heldMessages
      ? counterpart
      : { ...rest, messages: sharedMessages };
  });
  const pageParams = replaceEqualDeep(held.pageParams, next.pageParams);
  const unchanged =
    pages.length === held.pages.length &&
    pages.every((page, index) => page === held.pages[index]) &&
    pageParams === held.pageParams;
  return unchanged ? held : { ...next, pages, pageParams };
}
