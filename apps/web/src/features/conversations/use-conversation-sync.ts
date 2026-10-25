import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { StreamRead } from "./stream-state";
import { messageIdFromHash, threadRootFromMessageAnchor } from "./conversation-thread-search";
import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { conversationAroundQuery } from "./conversation-queries";
import type { ThreadRootLoad } from "./thread-root-state";
import type { DirectConversationView } from "./conversation-types";
import { threadReadThrough } from "./thread-summary-model";

type ConversationSyncView = Pick<
  DirectConversationView,
  "conversationId" | "messages" | "threadReadThrough"
>;

/**
 * The browser-only synchronization seam for a loaded conversation.
 *
 * The route loader owns the first page and the Query hook owns the cache. This hook owns the
 * transitions that depend on browser URL state or user visibility: deep-link window reads,
 * thread read acknowledgements, and the remembered set of mounted thread panes. Keeping those
 * effects here makes the data seam explicit instead of making the presentation file coordinate
 * fetches and local state at the same time.
 */
export function useConversationSync({
  conversation,
  searchThreadRootId,
  openTaskMessageId,
  taskRootReads,
  selected,
  threadInView,
  threadInViewSequence,
  onLoadMessageAround,
  onReadThread,
  openThreadFromHash,
  closeThread,
}: {
  conversation: ConversationSyncView;
  searchThreadRootId?: string;
  openTaskMessageId?: string;
  /** The read cursors that came with a Task popup root read outside the window (`useTaskPopupRoot`). */
  taskRootReads?: Readonly<Record<string, number>>;
  selected?: string;
  threadInView?: string;
  threadInViewSequence?: number;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  openThreadFromHash: (rootMessageId: string) => void;
  closeThread: () => void;
}) {
  const queryClient = useQueryClient();
  const [visited, setVisited] = useState<string[]>([]);
  // Replacing the window with an "around" read leaves the stream with no messages until its answer
  // lands; the stream must show loading, not "empty", while that is happening (stream-state.ts).
  const [windowRead, setWindowRead] = useState<StreamRead>("settled");
  const loadWindowAround = useCallback(
    async (messageId: string) => {
      if (!onLoadMessageAround) return;
      setWindowRead("loading");
      try {
        await onLoadMessageAround(messageId);
      } finally {
        setWindowRead("settled");
      }
    },
    [onLoadMessageAround],
  );

  // Only a read's failure is kept: a read that succeeded centres the window on the root
  // (`loadAround` answers NOT_FOUND otherwise), so until the root shows up it is loading.
  const [threadRootFailure, setThreadRootFailure] = useState<
    { rootId: string; load: Exclude<ThreadRootLoad, { status: "loading" }> } | undefined
  >();
  const loadThreadRoot = useCallback(
    async (rootId: string) => {
      setThreadRootFailure(undefined);
      try {
        await loadWindowAround(rootId);
      } catch (error) {
        setThreadRootFailure({
          rootId,
          load: isAppErrorCode(error, "NOT_FOUND")
            ? { status: "missing" }
            : { status: "failed", errorId: isAppError(error) ? error.errorId : undefined },
        });
      }
    },
    [loadWindowAround],
  );

  const persistedReads = useMemo(
    () =>
      taskRootReads
        ? { ...taskRootReads, ...conversation.threadReadThrough }
        : conversation.threadReadThrough,
    [taskRootReads, conversation.threadReadThrough],
  );

  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
  // This thread's read cursor (`threadReadThrough`): the stored one, raised by this visit's reads.
  const threadCursor = useCallback(
    (rootMessageId: string) =>
      threadReadThrough({ persistedReads, localReads: readThrough }, rootMessageId),
    [readThrough, persistedReads],
  );

  // Keep the selected thread mounted while the reader moves between threads. The task popup owns
  // its own pane, so it removes its root from this retained set below; a thread that stays
  // selected under the popup (one a host shows alone) comes back once the popup closes.
  useEffect(() => {
    if (!selected || selected === openTaskMessageId) return;
    setVisited((previous) => (previous.includes(selected) ? previous : [...previous, selected]));
  }, [selected, openTaskMessageId]);
  useEffect(() => {
    if (!openTaskMessageId) return;
    setVisited((previous) =>
      previous.includes(openTaskMessageId)
        ? previous.filter((rootId) => rootId !== openTaskMessageId)
        : previous,
    );
    if (selected === openTaskMessageId) closeThread();
  }, [openTaskMessageId, selected, closeThread]);

  const reading = useRef(false);
  useEffect(() => {
    if (
      !threadInView ||
      !threadInViewSequence ||
      reading.current ||
      document.visibilityState === "hidden"
    )
      return;
    const boundary = threadCursor(threadInView) ?? 0;
    if (threadInViewSequence <= boundary) return;
    reading.current = true;
    void (onReadThread?.(threadInView, threadInViewSequence) ?? Promise.resolve())
      .then(() => {
        setReadThrough((previous) => ({
          ...previous,
          [threadInView]: threadInViewSequence,
        }));
      })
      .catch(() => {
        // Leave unread intact; the next poll can retry the read acknowledgement.
      })
      .finally(() => {
        reading.current = false;
      });
  }, [threadInView, threadInViewSequence, conversation, onReadThread, readThrough, threadCursor]);

  // Hash-only deep links (notifications) still land on `#message-<id>`. Promote
  // that into `threadRootId` search once, then leave the hash as a scroll target.
  const attemptedHashLoad = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (searchThreadRootId) return;
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const rootMessageId = threadRootFromMessageAnchor(conversation.messages, hash);
    if (rootMessageId) openThreadFromHash(rootMessageId);
  }, [conversation.messages, searchThreadRootId, openThreadFromHash]);
  useEffect(() => {
    if (searchThreadRootId) return;
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    if (threadRootFromMessageAnchor(conversation.messages, hash)) return;
    const messageId = messageIdFromHash(hash);
    if (!messageId || attemptedHashLoad.current === hash) return;
    attemptedHashLoad.current = hash;
    // The window holds top-level messages only, so a reply's hash is never found in it: the read
    // around it answers with the thread it belongs to, which opens. A failed read leaves the
    // stream where it was, as a hash for a message that is gone does; the rejection is not left
    // unhandled.
    loadWindowAround(messageId)
      .then(() => {
        const around = queryClient.getQueryData(
          conversationAroundQuery(conversation.conversationId, messageId).queryKey,
        );
        if (around?.anchorThreadRootId) openThreadFromHash(around.anchorThreadRootId);
      })
      .catch(() => {});
  }, [
    conversation.messages,
    conversation.conversationId,
    searchThreadRootId,
    loadWindowAround,
    openThreadFromHash,
    queryClient,
  ]);

  return { visited, windowRead, threadCursor, threadRootFailure, loadThreadRoot };
}

/**
 * The Task popup's root message, which its thread pane hangs from. The popup can name a message
 * outside the bounded stream window; it then reads that message alone, beside the stream, and
 * never replaces the window around it: that would move the stream under the popup, and closing
 * the popup would leave the reader somewhere else in the history. A failed read leaves the popup
 * showing the Task without its thread.
 */
export function useTaskPopupRoot(
  conversation: Pick<ConversationSyncView, "conversationId" | "messages">,
  messageId: string | undefined,
) {
  const inWindow =
    messageId === undefined
      ? undefined
      : conversation.messages.find((message) => message.id === messageId);
  const read = useQuery({
    ...conversationAroundQuery(conversation.conversationId, messageId ?? ""),
    enabled: messageId !== undefined && !inWindow,
    select: (around) => ({
      root: around.messages.find((message) => message.id === messageId),
      reads: around.threadReadThrough,
    }),
  }).data;
  if (inWindow) return { root: inWindow, reads: undefined };
  return { root: read?.root, reads: read?.root ? read.reads : undefined };
}
