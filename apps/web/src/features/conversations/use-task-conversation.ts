import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { aroundWindowCursor } from "#src/lib/conversation-window";
import {
  loadTaskConversationUnread,
  markTaskConversationRead,
  openTaskConversation,
} from "#src/features/tasks/task-conversation.functions";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { useConversationOpened } from "./use-conversation-open";
import { taskConversationQueryKey } from "./conversation-query-keys";
import { conversationAroundQuery } from "./conversation-queries";
import { conversationRealtimeChannel, decodeMessageAvailableEvent } from "./conversation-realtime";
import { loadTaskConversation, loadTaskConversationUpdates } from "./conversations.functions";
import {
  catchUpTaskConversation,
  replaceTaskWindowAround,
  replaceTaskWindowWithNewest,
  taskConversationWindow,
  taskWindowMessages,
  TASK_WINDOW_START,
  withViewerSeat,
} from "./task-conversation-window";

const taskUnreadQueryKey = (conversationId: string | undefined) =>
  ["conversation", "task-unread", conversationId] as const;

export function useTaskConversation({
  known,
  board,
  jumpMessage,
}: {
  known: string | undefined;
  board: { conversationId: string; number: number };
  jumpMessage?: string;
}) {
  const load = useServerFn(loadTaskConversation);
  const loadUpdates = useServerFn(loadTaskConversationUpdates);
  const loadUnread = useServerFn(loadTaskConversationUnread);
  const open = useServerFn(openTaskConversation);
  const markRead = useServerFn(markTaskConversationRead);
  const queryClient = useQueryClient();
  const [made, setMade] = useState<string>();
  const conversationId = known ?? made;
  const followingLatest = useRef(false);
  const setFollowingLatest = useCallback((following: boolean) => {
    followingLatest.current = following;
  }, []);

  const landing = useQuery({
    ...conversationAroundQuery(conversationId ?? "", jumpMessage ?? ""),
    enabled: Boolean(conversationId && jumpMessage),
    retry: false,
  });
  const waitingForLanding = Boolean(conversationId && jumpMessage) && landing.isPending;
  const { query, loadInitialPage } = taskConversationWindow(
    conversationId,
    (page, signal) => load({ data: { conversationId: conversationId!, ...page }, signal }),
    {
      start: landing.data ? aroundWindowCursor(landing.data.messages) : TASK_WINDOW_START,
      followingLatest: () => followingLatest.current,
    },
  );
  const pages = useInfiniteQuery({
    ...query,
    enabled: conversationId !== undefined && !waitingForLanding,
  });
  const newest = pages.data?.pages.at(-1);
  const seated = Boolean(newest?.senderMemberId);
  const hasNewer = newest?.hasNewer ?? false;
  const messages = useMemo(() => taskWindowMessages(pages.data), [pages.data]);

  const unread = useQuery({
    queryKey: taskUnreadQueryKey(conversationId),
    queryFn: () => loadUnread({ data: { conversationId: conversationId! } }),
    enabled: Boolean(conversationId && seated),
  });

  const readTail = useCallback(
    (id: string) =>
      catchUpTaskConversation(queryClient, id, (data) => loadUpdates({ data })).catch(() => {}),
    [queryClient, loadUpdates],
  );
  const catchingUp = useRef<Promise<void>>(undefined);
  const catchUp = useCallback(
    (id: string) => {
      void queryClient.invalidateQueries(
        { queryKey: taskUnreadQueryKey(id) },
        { cancelRefetch: false },
      );
      catchingUp.current ??= readTail(id).finally(() => (catchingUp.current = undefined));
      return catchingUp.current;
    },
    [queryClient, readTail],
  );
  useRealtimeSubscription({
    channel: conversationId ? conversationRealtimeChannel(conversationId) : undefined,
    recoverable: true,
    onSubscribed: useCallback(() => {
      if (conversationId) void catchUp(conversationId);
    }, [catchUp, conversationId]),
    onPublication: useCallback(
      ({ data }: { data: unknown }) => {
        try {
          if (decodeMessageAvailableEvent(data).conversationId === conversationId)
            void catchUp(conversationId);
        } catch {
          return;
        }
      },
      [catchUp, conversationId],
    ),
  });
  const loaded = pages.isSuccess;
  useEffect(() => {
    if (loaded && conversationId) void catchUp(conversationId);
  }, [loaded, conversationId, catchUp]);

  const opened = useConversationOpened(
    conversationId ?? "",
    undefined,
    Boolean(conversationId && seated),
  );
  const last = messages.at(-1)?.sequence;
  const readBefore = newest?.readThroughSequence ?? 0;
  const readThrough = useRef(0);
  const reachedLatest = useRef(false);
  const { conversationId: boardId, number } = board;
  const readingRef = useRef({ last, hasNewer, readBefore, seated, opened });
  readingRef.current = { last, hasNewer, readBefore, seated, opened };
  const markThrough = useCallback(
    (through: number) => {
      const now = readingRef.current;
      if (!now.seated || !now.opened) return;
      if (through <= Math.max(readThrough.current, now.readBefore)) return;
      void markRead({ data: { conversationId: boardId, number, throughSequence: through } }).then(
        () => {
          readThrough.current = Math.max(readThrough.current, through);
          if (through === readingRef.current.last && !readingRef.current.hasNewer)
            queryClient.setQueryData(taskUnreadQueryKey(conversationId), { unreadCount: 0 });
          else void queryClient.invalidateQueries({ queryKey: taskUnreadQueryKey(conversationId) });
        },
        () => {},
      );
    },
    [markRead, queryClient, boardId, number, conversationId],
  );
  const readLatest = useCallback(() => {
    const now = readingRef.current;
    if (!now.last || now.hasNewer) return;
    reachedLatest.current = true;
    markThrough(now.last);
  }, [markThrough]);
  useEffect(() => {
    if (opened && reachedLatest.current) readLatest();
  }, [opened, readLatest]);
  useEffect(() => {
    if (reachedLatest.current && followingLatest.current) readLatest();
  }, [last, readLatest]);

  const opening = useRef<Promise<string>>(undefined);
  const ensure = useCallback(() => {
    opening.current ??= open({ data: { conversationId: boardId, number } }).then(
      async ({ conversationId: opened }) => {
        setMade(opened);
        const page = await load({ data: { conversationId: opened } }).catch(() => undefined);
        if (page)
          queryClient.setQueryData(taskConversationQueryKey(opened), (data: typeof pages.data) =>
            withViewerSeat(data, page.senderMemberId),
          );
        return opened;
      },
      (error: unknown) => {
        opening.current = undefined;
        throw error;
      },
    );
    return opening.current;
  }, [open, load, queryClient, boardId, number]);

  const { fetchNextPage, fetchPreviousPage, hasPreviousPage } = pages;
  const loadOlder = useCallback(async () => {
    await fetchPreviousPage({ throwOnError: true });
  }, [fetchPreviousPage]);
  const loadNewer = useCallback(async () => {
    await fetchNextPage({ throwOnError: true });
    if (conversationId) await readTail(conversationId);
  }, [fetchNextPage, readTail, conversationId]);
  const loadMessageAround = useCallback(
    async (messageId: string) => {
      if (!conversationId) throw new Error("message not found");
      const around = await queryClient.fetchQuery(
        conversationAroundQuery(conversationId, messageId),
      );
      await replaceTaskWindowAround(queryClient, conversationId, around);
      return around.anchorMessageId;
    },
    [queryClient, conversationId],
  );
  const showLatest = useCallback(async () => {
    if (!conversationId) return;
    await replaceTaskWindowWithNewest(queryClient, conversationId, await loadInitialPage());
    await readTail(conversationId);
    const tail = taskWindowMessages(
      queryClient.getQueryData(taskConversationQueryKey(conversationId)),
    ).at(-1);
    reachedLatest.current = true;
    if (tail) markThrough(tail.sequence);
  }, [queryClient, conversationId, loadInitialPage, readTail, markThrough]);

  return {
    conversationId,
    made,
    pages,
    newest,
    seated,
    messages,
    unreadCount: seated ? (unread.data?.unreadCount ?? 0) : undefined,
    hasOlder: hasPreviousPage,
    hasNewer,
    catchUp,
    ensure,
    loadOlder,
    loadNewer,
    loadMessageAround,
    showLatest,
    readLatest,
    setFollowingLatest,
  };
}
