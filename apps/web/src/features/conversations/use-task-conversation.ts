import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  markTaskConversationRead,
  openTaskConversation,
} from "#src/features/tasks/task-conversation.functions";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { useConversationOpened } from "./use-conversation-open";
import { taskConversationQueryKey } from "./conversation-query-keys";
import { conversationRealtimeChannel, decodeMessageAvailableEvent } from "./conversation-realtime";
import { loadTaskConversation, loadTaskConversationUpdates } from "./conversations.functions";
import {
  catchUpTaskConversation,
  loadTaskBackTo,
  withNewest,
  type Page,
} from "./task-conversation-window";

/**
 * A Task's own conversation, as its popup reads it: the newest page, older ones on request, and
 * what arrives after (`message.available.v1` on the conversation's channel). The viewer's read
 * position follows the newest message while they have a seat.
 *
 * It makes nothing by being read. `ensure` makes the conversation and the viewer's seat in it
 * (`openTaskConversation`), once however many ask at the same time; a reply makes both on the
 * server, and `ensure` then only names the conversation.
 */
export function useTaskConversation({
  known,
  board,
}: {
  /** The Task's conversation; absent until someone has spoken there. */
  known: string | undefined;
  /** The Task by its board and number. */
  board: { conversationId: string; number: number };
}) {
  const load = useServerFn(loadTaskConversation);
  const loadUpdates = useServerFn(loadTaskConversationUpdates);
  const open = useServerFn(openTaskConversation);
  const markRead = useServerFn(markTaskConversationRead);
  const queryClient = useQueryClient();
  // The conversation made here, until the Task itself names it.
  const [made, setMade] = useState<string>();
  const conversationId = known ?? made;
  const pages = useInfiniteQuery({
    queryKey: taskConversationQueryKey(conversationId),
    queryFn: ({ pageParam }) =>
      load({ data: { conversationId: conversationId!, beforeSequence: pageParam } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => (page.hasOlder ? page.messages[0]?.sequence : undefined),
    enabled: conversationId !== undefined,
  });
  const newest = pages.data?.pages[0];
  const seated = Boolean(newest?.senderMemberId);

  // One catch-up at a time: a send, a publication and a resubscribe asking together share it.
  const catchingUp = useRef<Promise<void>>(undefined);
  const catchUp = useCallback(
    (id: string) => {
      catchingUp.current ??= catchUpTaskConversation(queryClient, id, (data) =>
        loadUpdates({ data }),
      )
        // A missed read is made up by the next publication or resubscribe.
        .catch(() => {})
        .finally(() => (catchingUp.current = undefined));
      return catchingUp.current;
    },
    [queryClient, loadUpdates],
  );
  useRealtimeSubscription({
    channel: conversationId ? conversationRealtimeChannel(conversationId) : undefined,
    recoverable: true,
    // A resubscribe may have missed replies.
    onSubscribed: useCallback(() => {
      if (conversationId) void catchUp(conversationId);
    }, [catchUp, conversationId]),
    onPublication: useCallback(
      ({ data }: { data: unknown }) => {
        try {
          if (decodeMessageAvailableEvent(data).conversationId === conversationId)
            void catchUp(conversationId);
        } catch {
          // Not a new message: reactions and the like, which this stream does not follow.
        }
      },
      [catchUp, conversationId],
    ),
  });
  // A reply published while the first page was on its way found nothing to join: look once more.
  const loaded = pages.isSuccess;
  useEffect(() => {
    if (loaded && conversationId) void catchUp(conversationId);
  }, [loaded, conversationId, catchUp]);

  // The reader has seen up to the newest message: their read position follows it, but only once
  // this open has read where their unread starts, or the pane's divider would find nothing unread
  // (task #99), as a channel's cursor waits for its open.
  const opened = useConversationOpened(
    conversationId ?? "",
    undefined,
    Boolean(conversationId && seated),
  );
  const last = newest?.messages.at(-1)?.sequence;
  const readBefore = newest?.readThroughSequence ?? 0;
  const readThrough = useRef(0);
  const { conversationId: boardId, number } = board;
  useEffect(() => {
    if (!last || !seated || !opened || last <= Math.max(readThrough.current, readBefore)) return;
    void markRead({ data: { conversationId: boardId, number, throughSequence: last } }).then(
      () => (readThrough.current = Math.max(readThrough.current, last)),
      () => {},
    );
  }, [last, seated, opened, readBefore, markRead, boardId, number]);

  // One opening serves every caller at once; a failed one does not stand in for the next try.
  const opening = useRef<Promise<string>>(undefined);
  const ensure = useCallback(() => {
    opening.current ??= open({ data: { conversationId: boardId, number } }).then(
      async ({ conversationId: opened }) => {
        setMade(opened);
        // The viewer has a seat now: the newest page says so once read again.
        const page = await load({ data: { conversationId: opened } }).catch(() => undefined);
        if (page)
          queryClient.setQueryData<InfiniteData<Page>>(taskConversationQueryKey(opened), (data) =>
            withNewest(data, (first) => ({ ...first, senderMemberId: page.senderMemberId })),
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

  // The pages run newest first; the stream reads oldest first.
  const messages = useMemo(
    () => [...(pages.data?.pages ?? [])].reverse().flatMap((page) => page.messages),
    [pages.data],
  );
  const { fetchNextPage } = pages;
  const loadBackTo = useCallback(
    (messageId: string) =>
      loadTaskBackTo({ queryClient, conversationId, messageId, catchUp, fetchNextPage }),
    [fetchNextPage, queryClient, conversationId, catchUp],
  );

  return { conversationId, made, pages, newest, seated, messages, catchUp, ensure, loadBackTo };
}
