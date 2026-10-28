import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  queryOptions,
  useQueryClient,
  useSuspenseInfiniteQuery,
  hashKey,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import { isAppErrorCode } from "#src/lib/app-error";
import { mergeMessages } from "./conversation-messages";
import {
  createConversationReconciler,
  type ConversationUpdatesCursor,
} from "./conversation-reconciliation";
import { useConversationRealtime } from "./conversation-realtime-client";
import {
  flushWindowUpdates,
  foldWindowUpdates,
  type ConversationWindowCursor,
} from "#src/lib/conversation-window";
import {
  conversationPages,
  type ConversationPage,
  type PageMessage,
} from "./conversation-window-query";
import {
  loadConversationAround,
  loadDirectConversation,
  loadDirectConversationUpdates,
} from "./conversations.functions";
import {
  listChannelNames,
  loadPublicChannel,
  loadPublicChannelUpdates,
} from "./channels.functions";
import { refreshPendingActionCards } from "./action-card-refresh";
import { loadMessageReactions } from "./message-reactions.functions";
import { createReactionSync } from "./reaction-sync";
import { channelMembersQueryKey, channelNamesQueryKey } from "./conversation-query-keys";
import { savedMessagesQueryKey } from "./saved-messages-collection";
import { listSavedMessages } from "./saved-messages.functions";
import {
  applyThreadRead,
  conversationThreadsQueryKey,
  foldThreadReplies,
  loadedThreadReplies,
  setThreadFollowed,
  updateLoadedReply,
} from "./thread-cache";
import { mergeWindowThreads, newestReflectedSequence } from "./thread-summary-model";
import type { ConversationReadEvent } from "./conversation-realtime";

export const directConversationQuery = (conversationId: string) =>
  conversationPages(["conversation", "direct", conversationId], (page) =>
    loadDirectConversation({ data: { conversationId, ...page } }),
  );

export const publicChannelQuery = (channelId: string) =>
  conversationPages(["conversation", "channel", channelId], (page) =>
    loadPublicChannel({ data: { channelId, ...page } }),
  );

/** The window an around read answers, without `anchorThreadRootId`, which only its caller needs:
 * the root of the thread a reply anchor belongs to. */
export function aroundWindow<A extends { anchorThreadRootId?: string }>({
  anchorThreadRootId: _anchorThreadRootId,
  ...window
}: A) {
  return window;
}

/** A bounded window around one message, kept in the same Query cache as the stream. */
export const conversationAroundQuery = (conversationId: string, messageId: string) =>
  queryOptions({
    queryKey: ["conversation", "around", conversationId, messageId],
    queryFn: () => loadConversationAround({ data: { conversationId, messageId } }),
    staleTime: 0,
  });

/** The viewer's Saved list, the Query the Saved collection (`saved-messages-collection.ts`) syncs
 * from: a host's loader reads it into the cache, and the collection starts from what is there. Its
 * data is a whole read (`SavedList`): the entries, and the stream position it was read at. */
export const savedMessagesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: savedMessagesQueryKey(workspaceId),
    queryFn: () => listSavedMessages(),
  });

/** Every channel of the Workspace by id, closed ones included — what a body's channel links and
 * the composer's `#` list read, in Chat and on any page that shows a conversation (the Tasks page's
 * popup). Chat keeps it live: `channel.created.v1` and `channel.updated.v1` are written into it
 * (`useApplyChannelSignal`). The Query holds the whole read, the names beside the stream position
 * they were read at; a hook reading it gets the names. */
export const channelNamesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: channelNamesQueryKey(workspaceId),
    queryFn: () => listChannelNames(),
    select: namesOfRead,
    staleTime: 60_000,
  });

function namesOfRead(read: Awaited<ReturnType<typeof listChannelNames>>) {
  return read.names;
}

export const directConversationUpdates =
  (conversationId: string) => (cursor: ConversationUpdatesCursor) =>
    loadDirectConversationUpdates({ data: { conversationId, ...cursor } });

export const publicChannelUpdates = (channelId: string) => (cursor: ConversationUpdatesCursor) =>
  loadPublicChannelUpdates({ data: { channelId, ...cursor } });

type Pages<T> = InfiniteData<T, ConversationWindowCursor>;

/**
 * Calls `listener` with a query's data each time a network read of it succeeds, and not when the
 * page writes the data itself (`setQueryData` marks those `manual` in TanStack Query) or loads
 * more pages. Returns the unsubscribe.
 */
export function onNetworkRead<D>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  listener: (data: D) => void,
) {
  const queryHash = hashKey(queryKey);
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryHash !== queryHash) return;
    if (event.action.type !== "success" || event.action.manual) return;
    // Loading older or newer pages keeps the pages already held as they were: not a read of them.
    if (event.query.state.fetchMeta?.fetchMore) return;
    listener(event.action.data as D);
  });
}

/** The conversation no longer exists for this viewer, such as a channel hidden from the
 * Workspace: its page leaves for Chat instead of showing a load failure. */
export function isConversationGone(error: unknown) {
  return isAppErrorCode(error, "NOT_FOUND");
}

/**
 * A message route's conversation, read from the Query cache the loader populated.
 * Older history is more pages of the same infinite query; everything that arrives later
 * (polls, realtime, the user's own sends, an "around" jump) is written into the cache with
 * setQueryData, so every reader of the key sees the same conversation.
 */
export function useConversationQuery<M extends PageMessage, T extends ConversationPage<M>>({
  query,
  loadInitialPage,
  loadUpdates,
  onRealtime,
  onArrived,
}: {
  query: ReturnType<typeof conversationPages<M, T>>["query"];
  /** The newest page on its own: how "back to latest" recovers a tail the window evicted. */
  loadInitialPage: () => Promise<T>;
  loadUpdates: (cursor: ConversationUpdatesCursor) => Promise<M[]>;
  /** Extra work per realtime event, run alongside reconciliation. */
  onRealtime?: () => Promise<unknown>;
  /** The messages `mergeUpdates` folds in, as they arrive. */
  onArrived?: (conversationId: string, messages: readonly M[]) => void;
}) {
  const queryClient = useQueryClient();
  /** The pane updates this synchronously from its real scroll position. Query meta lets a focus or
   * invalidation refetch read it without putting viewport state in the cache's data. */
  const followingLatestRef = useRef(true);
  const observedQuery = {
    ...query,
    meta: {
      ...query.meta,
      conversationFollowingLatest: () => followingLatestRef.current,
    },
  };
  const { data, error, hasPreviousPage, hasNextPage, fetchPreviousPage, fetchNextPage } =
    useSuspenseInfiniteQuery(observedQuery);
  // A refetch that finds the conversation gone (a channel hidden from the Workspace) keeps the
  // stale pages; hand the error to the route's error view, which leaves for Chat. The cached
  // pages and error go too, so opening it again later (after a restore) fetches afresh.
  if (isConversationGone(error)) {
    queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
    throw error;
  }
  const latestPage = data.pages.at(-1)!;
  const conversationId = latestPage.conversationId;

  // Other members' reads heard live since the page was read. Kept apart from the cached pages and
  // merged by max, so a refetch that raced a read event cannot take a tick back.
  const [liveOthersRead, setLiveOthersRead] = useState<{
    conversationId: string;
    sequence: number;
  }>();
  const senderMemberId = latestPage.senderMemberId;
  const onRead = useCallback(
    (event: ConversationReadEvent) => {
      if (event.memberId === senderMemberId) return;
      setLiveOthersRead((current) => {
        const heard = current?.conversationId === event.conversationId ? current.sequence : 0;
        return event.readThroughSequence > heard
          ? { conversationId: event.conversationId, sequence: event.readThroughSequence }
          : current;
      });
    },
    [senderMemberId],
  );
  const othersReadThroughSequence = Math.max(
    latestPage.othersReadThroughSequence ?? 0,
    liveOthersRead?.conversationId === conversationId ? liveOthersRead.sequence : 0,
  );

  const conversation = useMemo(
    () => ({
      ...latestPage,
      othersReadThroughSequence,
      hasOlder: hasPreviousPage,
      hasNewer: latestPage.hasNewer ?? false,
      messages: data.pages.reduce<M[]>((all, page) => mergeMessages(all, page.messages), []),
      // Each page holds the threads, reads and follows of its own roots: the window's are all of them.
      ...mergeWindowThreads(data.pages),
    }),
    [data, hasPreviousPage, latestPage, othersReadThroughSequence],
  );

  const setPages = (update: (pages: Pages<T>) => Pages<T>) =>
    queryClient.setQueryData<Pages<T>>(query.queryKey, (pages) => (pages ? update(pages) : pages));

  /**
   * Messages the retained window cannot hold yet. While the newest retained page is not the live
   * tail (`hasNewer`), a top-level message must not be folded into it: it waits (deduped by id) and
   * is merged once the tail is back. A thread's replies never wait: they go to their root's summary
   * and open thread wherever the root is loaded (`foldThreadReplies`).
   */
  const pendingUpdatesRef = useRef<M[]>([]);

  /** Fold freshly received messages into the loaded conversation: top-level ones into the latest
   * window, unless pinned to an older one; replies into their threads. Roots go first, so a reply
   * that arrives with its own root finds the root loaded. */
  const mergeUpdates = (updates: M[]) => {
    onArrived?.(conversationId, updates);
    const roots = updates.filter((message) => !message.threadRootId);
    if (roots.length)
      setPages((pages) => {
        const latest = pages.pages.at(-1);
        const fold = foldWindowUpdates(latest, pendingUpdatesRef.current, roots, mergeMessages);
        if (!fold || !latest) return pages;
        pendingUpdatesRef.current = fold.pending;
        if (!fold.messages) return pages;
        return {
          ...pages,
          pages: [...pages.pages.slice(0, -1), { ...latest, messages: fold.messages }],
        };
      });
    foldThreadReplies<M, T>(queryClient, {
      pagesKey: query.queryKey,
      conversationId,
      replies: updates,
      // Nothing is unread for someone who is not a member.
      viewerIsMember: Boolean(latestPage.senderMemberId),
    });
  };

  /** Merge anything buffered while the tail was evicted into the newest page, once it is the tail
   * again. Leaves the buffer intact if it is still not (more forward pages remain). */
  const flushPendingUpdates = () =>
    setPages((pages) => {
      const latest = pages.pages.at(-1);
      const messages = flushWindowUpdates(latest, pendingUpdatesRef.current, mergeMessages);
      if (!messages || !latest) return pages;
      pendingUpdatesRef.current = [];
      return {
        ...pages,
        pages: [...pages.pages.slice(0, -1), { ...latest, messages }],
      };
    });

  const loadUpdatesRef = useRef(loadUpdates);
  loadUpdatesRef.current = loadUpdates;
  const mergeUpdatesRef = useRef(mergeUpdates);
  mergeUpdatesRef.current = mergeUpdates;
  const onRealtimeRef = useRef(onRealtime);
  onRealtimeRef.current = onRealtime;

  const reconciliation = useMemo(
    () =>
      createConversationReconciler(
        {
          afterSequence: latestPage.messages.at(-1)?.sequence ?? 0,
          afterReplySequence: newestReflectedSequence(latestPage),
        },
        (cursor) => loadUpdatesRef.current(cursor),
        (updates) => mergeUpdatesRef.current(updates),
      ),
    // A new conversation starts a new reconciler; later pages of the same one keep it.
    [conversationId],
  );
  // The window's own network read moves the reconciler past what it holds (see `advance`); the
  // page's own writes to the window (a sent message merged in) do not, since messages from others
  // that arrived before it may still be unread.
  // Keyed by the hash: callers build `query` afresh each render, and the key is what matters.
  const windowKey = query.queryKey;
  const windowHash = hashKey(windowKey);
  useEffect(
    () =>
      onNetworkRead<Pages<T>>(queryClient, windowKey, (pages) => {
        const newest = pages.pages.at(-1);
        if (!newest) return;
        reconciliation.advance({
          afterSequence: newest.messages.at(-1)?.sequence ?? 0,
          afterReplySequence: newestReflectedSequence(newest),
        });
      }),
    // `windowKey` changes only with `windowHash`.
    [queryClient, windowHash, reconciliation],
  );
  /** The loaded messages, in the window and the open threads, read at call time. */
  const loaded = () => [
    ...conversation.messages,
    ...loadedThreadReplies<M>(queryClient, conversationId),
  ];
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  /** Replace one loaded message, in the window or in the open thread that holds it, keeping every
   * other page, thread and message object as it is. */
  const updateMessage = (messageId: string, update: (message: M) => M) => {
    setPages((pages) => ({
      ...pages,
      pages: pages.pages.map((page) =>
        page.messages.some((message) => message.id === messageId)
          ? {
              ...page,
              messages: page.messages.map((message) =>
                message.id === messageId ? update(message) : message,
              ),
            }
          : page,
      ),
    }));
    updateLoadedReply<M>(queryClient, conversationId, messageId, update);
  };
  const updateMessageRef = useRef(updateMessage);
  updateMessageRef.current = updateMessage;
  const reactionSync = useMemo(
    () =>
      createReactionSync<M>({
        loaded: () => loadedRef.current(),
        update: (messageId, update) => updateMessageRef.current(messageId, update),
        load: (messageIds) => loadMessageReactions({ data: { conversationId, messageIds } }),
        // A reaction that failed may sit on a reply, which the window does not hold: the open
        // threads are read again with it.
        resync: () =>
          Promise.all([
            queryClient.invalidateQueries({ queryKey: query.queryKey }),
            queryClient.invalidateQueries({
              queryKey: conversationThreadsQueryKey(conversationId),
            }),
          ]),
      }),
    // A new conversation starts a new one, like the reconciler above.
    [conversationId],
  );
  useConversationRealtime(
    conversationId,
    async () => {
      await Promise.all([
        reconciliation.reconcile(),
        onRealtimeRef.current?.(),
        refreshPendingActionCards(loadedRef.current(), updateMessageRef.current),
      ]);
    },
    // A membership change stale-dates the composer's @-directory (and plain-@handle
    // resolution) and the settings panel's Members strip; the next render picks the refetched
    // lists up. The first subscribe refetches only the directory the page payload carried
    // (`exact`): the outsiders list under the same prefix was first read after hydration, and a
    // second read would only duplicate it. Inert for DMs.
    (stale) =>
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["conversation", "mentionables", conversationId],
          exact: stale === "page-payload",
        }),
        queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(conversationId) }),
      ]).catch(() => {}),
    // The channel was renamed, described, archived, unarchived or hidden elsewhere: refetch the
    // page, which carries those facts. Inert for DMs.
    () => void queryClient.invalidateQueries({ queryKey: query.queryKey }).catch(() => {}),
    (event) => reactionSync.apply(event.messageId, event),
    () => void reactionSync.repair(),
    onRead,
  );

  /** Replace the loaded history with a window around one message. */
  const loadMessageAround = async (messageId: string) => {
    const around = await queryClient.fetchQuery(conversationAroundQuery(conversationId, messageId));
    setPages((pages) => ({
      pages: [{ ...pages.pages.at(-1)!, ...aroundWindow(around) }],
      pageParams: [undefined],
    }));
  };

  return {
    conversation,
    reconciliation,
    mergeUpdates,
    /** Tell refetch whether replacing the retained window with the newest page may discard rows. */
    setFollowingLatest: (following: boolean) => {
      followingLatestRef.current = following;
    },
    /** The viewer read a thread through a reply: its summary and cursor follow, on whichever page
     * holds its root, without a refetch. */
    applyThreadRead: (rootId: string, throughSequence: number) =>
      applyThreadRead<T>(queryClient, { pagesKey: query.queryKey, rootId, throughSequence }),
    /** The viewer followed or unfollowed a thread, on whichever page holds its root. */
    setThreadFollowed: (rootId: string, followed: boolean) =>
      setThreadFollowed<T>(queryClient, { pagesKey: query.queryKey, rootId, followed }),
    loadMessageAround,
    /** Make sure a message is loaded before navigating to it. */
    ensureLoaded: async (messageId: string) => {
      if (!conversation.messages.some((message) => message.id === messageId))
        await loadMessageAround(messageId);
    },
    /** Fetch the page before the oldest loaded one. A failed read rejects (TanStack resolves it by
     * default), so the pane can offer a retry instead of a row that never loads. */
    loadOlder: async () => {
      if (hasPreviousPage) await fetchPreviousPage({ throwOnError: true });
    },
    /** Fetch the next page towards the live end after the window slid up into history and
     * evicted the tail, then merge anything that arrived while the tail was gone. */
    loadNewer: async () => {
      if (!hasNextPage) return;
      await fetchNextPage();
      flushPendingUpdates();
    },
    /** Leave an "around" window, or a history window whose tail the bounded window evicted, and
     * return to the live end. Replaces the loaded pages with a fresh newest page rather than
     * re-fetching the existing (possibly evicted) window, so the tail really is loaded when this
     * resolves; the pane's pending-latest effect then scrolls to it. */
    showLatest: async () => {
      const newest = await loadInitialPage();
      // A real read of the newest page: the reconciler need not read what it holds again.
      reconciliation.advance({
        afterSequence: newest.messages.at(-1)?.sequence ?? 0,
        afterReplySequence: newestReflectedSequence(newest),
      });
      const buffered = pendingUpdatesRef.current;
      pendingUpdatesRef.current = [];
      queryClient.setQueryData<Pages<T>>(query.queryKey, {
        pages: [
          buffered.length
            ? { ...newest, messages: mergeMessages(newest.messages, buffered) }
            : newest,
        ],
        pageParams: [undefined],
      });
    },
    /** Re-read every loaded page after a change the realtime feed does not carry. */
    invalidate: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
    /** Toggle the viewer's reaction: shown at once, settled by the server's summary for that
     * message (`reaction-sync.ts`), re-read only when the call fails. */
    toggleReaction: reactionSync.toggle,
  };
}
