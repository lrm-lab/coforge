import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  awaitingRestoredRead,
  subscribeRestoredReads,
} from "#src/features/cache-persistence/browser-query-cache";
import { unreadBoundary, type UnreadBoundary } from "./conversation-open-position";
import { conversationWindowKeys } from "./conversation-queries";
import { isViewerMessage } from "./own-message";

/**
 * Captures the unread divider's position once when a conversation or thread opens. The default
 * lands on the first unread message, like Slack; the divider stays frozen while the mark-read
 * effect advances the server cursor.
 *
 * The copy a conversation opens on may predate messages that arrived since (task #276). One kept
 * in memory since the reader was last here is caught up by the first read past it after the open
 * (`caughtUpThrough`): with nothing unread yet, the divider goes above the first message past the
 * cursor the conversation opened with, up to the newest message that read found. What came after
 * it arrived while the conversation was open, and is never the start of what was new. The
 * browser's stored copy (task #253) is not captured at all until its own read has landed, which
 * carries the server's cursor (it may have been read elsewhere since). A divider found late opens the pane on it, as `openKey` changes; a reader who
 * has scrolled away from the latest meanwhile stays where they are.
 */
export function useConversationOpenBoundary(
  {
    messages,
    readThroughSequence,
    conversationId,
    senderMemberId,
    caughtUp = true,
    caughtUpThrough,
  }: {
    messages: readonly OpenMessage[];
    readThroughSequence?: number;
    conversationId: string;
    /** The viewer: what they sent themselves is never the start of their unread. */
    senderMemberId?: string;
    /** A read has caught this open up with what arrived (`createConversationReconciler`). */
    caughtUp?: boolean;
    /** The newest message there was when it did. */
    caughtUpThrough?: number;
  },
  rootId: string | undefined,
  followingLatest: boolean,
) {
  const restoring = useAwaitingRestoredWindow(conversationId);
  const key = `${conversationId}:${rootId ?? ""}`;
  const capture = (waited: boolean): Opened => ({
    key,
    cursor: readThroughSequence,
    boundary: unreadBoundary(messages, readThroughSequence, senderMemberId),
    // After a wait the pane opens again only for a reader still at the latest.
    openKey: waited && !followingLatest ? `${conversationId}:opening` : conversationId,
  });
  const [opened, setOpened] = useState<Opened | Waiting>(() =>
    restoring ? { key, waiting: true } : capture(false),
  );
  const current = opened.key === key ? opened : undefined;
  // Set during render, as derived state: the pane's open effect sees it in the same commit.
  if (restoring) {
    if (!current) setOpened({ key, waiting: true });
  } else if (!current || "waiting" in current) {
    setOpened(capture(Boolean(current)));
  } else if (
    !current.boundary &&
    !current.settled &&
    (!caughtUp || caughtUpThrough !== undefined) &&
    !rootId &&
    current.cursor !== undefined
  ) {
    // What the viewer sent since the open, they have read up to.
    const ownThrough = Math.max(
      current.cursor,
      ...messages
        .filter((message) => isViewerMessage(message, senderMemberId))
        .map((message) => message.sequence),
    );
    const openedThrough = caughtUp ? caughtUpThrough! : Infinity;
    const found = unreadBoundary(
      messages.filter((message) => message.sequence <= openedThrough),
      ownThrough,
      senderMemberId,
    );
    // Once the window holds everything the catch-up found, nothing later can be the divider's.
    const settled = (messages.at(-1)?.sequence ?? 0) >= openedThrough;
    if (found)
      setOpened({
        ...current,
        boundary: found,
        openKey: followingLatest ? `${conversationId}:found` : current.openKey,
      });
    else if (settled) setOpened({ ...current, settled });
  }
  const shown = current && !("waiting" in current) ? current : undefined;
  return {
    boundary: shown?.boundary,
    openKey: shown?.openKey ?? `${conversationId}:opening`,
  };
}

type OpenMessage = UnreadBoundary & { senderMemberId?: string | null };
type Opened = {
  key: string;
  cursor?: number;
  boundary?: UnreadBoundary;
  openKey: string;
  /** No divider: the window held everything the open was caught up with, none of it unread. */
  settled?: boolean;
};
type Waiting = { key: string; waiting: true };

/**
 * Whether the conversation's window is the browser's stored copy, still waiting for its own read
 * (task #253). Its cursors, the thread cursors with it, may be older than the server's, or missing
 * for a thread that came since: a divider waits for that read, and so does a thread's mark-read,
 * which would otherwise move the server's cursor before the divider is found.
 */
export function useAwaitingRestoredWindow(conversationId: string) {
  const queryClient = useQueryClient();
  const windowKeys = useMemo(() => conversationWindowKeys(conversationId), [conversationId]);
  return useSyncExternalStore(
    useCallback((listener) => subscribeRestoredReads(queryClient, listener), [queryClient]),
    () => windowKeys.some((key) => awaitingRestoredRead(queryClient, key)),
    () => false,
  );
}
