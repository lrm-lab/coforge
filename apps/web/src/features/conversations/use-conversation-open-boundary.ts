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
 * (`caughtUp`): until then, with nothing unread yet, the divider goes above the first message past
 * the cursor the conversation opened with. The browser's stored copy (task #253) is not captured
 * at all until its own read has landed, which carries the server's cursor (it may have been read
 * elsewhere since). A divider found late opens the pane on it, as `openKey` changes; a reader who
 * has scrolled away from the latest meanwhile stays where they are.
 */
export function useConversationOpenBoundary(
  {
    messages,
    readThroughSequence,
    conversationId,
    senderMemberId,
    caughtUp = true,
  }: {
    messages: readonly OpenMessage[];
    readThroughSequence?: number;
    conversationId: string;
    /** The viewer: what they sent themselves is never the start of their unread. */
    senderMemberId?: string;
    /** A read has caught this open up with what arrived (`createConversationReconciler`). */
    caughtUp?: boolean;
  },
  rootId: string | undefined,
  followingLatest: boolean,
) {
  const queryClient = useQueryClient();
  const windowKeys = useMemo(() => conversationWindowKeys(conversationId), [conversationId]);
  // A thread is read with its conversation: only the conversation's window is restored or caught up.
  const restoring = useSyncExternalStore(
    useCallback((listener) => subscribeRestoredReads(queryClient, listener), [queryClient]),
    () => !rootId && windowKeys.some((key) => awaitingRestoredRead(queryClient, key)),
    () => false,
  );
  const key = `${conversationId}:${rootId ?? ""}`;
  const capture = (waited: boolean): Opened => ({
    key,
    cursor: readThroughSequence,
    boundary: unreadBoundary(messages, readThroughSequence),
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
  } else if (!current.boundary && !caughtUp && !rootId && current.cursor !== undefined) {
    // What the viewer sent since the open, they have read up to.
    const ownThrough = Math.max(
      current.cursor,
      ...messages
        .filter((message) => isViewerMessage(message, senderMemberId))
        .map((message) => message.sequence),
    );
    const found = unreadBoundary(messages, ownThrough);
    if (found)
      setOpened({
        ...current,
        boundary: found,
        openKey: followingLatest ? `${conversationId}:found` : current.openKey,
      });
  }
  const shown = current && !("waiting" in current) ? current : undefined;
  return {
    boundary: shown?.boundary,
    openKey: shown?.openKey ?? `${conversationId}:opening`,
  };
}

type OpenMessage = UnreadBoundary & { senderMemberId?: string | null };
type Opened = { key: string; cursor?: number; boundary?: UnreadBoundary; openKey: string };
type Waiting = { key: string; waiting: true };
