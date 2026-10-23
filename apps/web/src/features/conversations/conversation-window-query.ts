// The stream's TanStack infinite query: a conversation's bounded window of pages, and the size and
// cursor each page is read with (the window's rules are in `lib/conversation-window.ts`).
import { infiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";

import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
  nextPageCursor,
  previousPageCursor,
  windowPageLimit,
  type ConversationWindowCursor,
} from "#src/lib/conversation-window";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import type { ReactionSummary } from "./message-reactions";
import type { ThreadReplyInput, WindowThreadsPage } from "./thread-summary-model";

export type PageMessage = ThreadReplyInput & {
  threadRootId?: string;
  actionCard?: ActionCardView;
  reactions?: ReactionSummary[];
};
export type ConversationPage<M extends PageMessage> = WindowThreadsPage & {
  conversationId: string;
  /** The viewer's member row in the conversation; empty for someone who never joined or left. */
  senderMemberId?: string;
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
  loadPage: (page: PageRequest) => Promise<T>,
) {
  // The bounded window: `maxPages` keeps the loaded pages from growing with every page of history
  // read, dropping the page at the far end from the fetch (see `lib/conversation-window.ts`).
  const query = infiniteQueryOptions({
    queryKey,
    queryFn: ({ client, queryKey, pageParam, meta }) => {
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
      return loadPage({
        beforeSequence: requestCursor?.before,
        afterSequence: requestCursor?.after,
        limit: windowPageLimit({
          forward: requestCursor?.after !== undefined,
          fullRefetch,
          windowAtTail,
        }),
      });
    },
    initialPageParam: undefined as ConversationWindowCursor,
    maxPages: CONVERSATION_WINDOW_MAX_PAGES,
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
