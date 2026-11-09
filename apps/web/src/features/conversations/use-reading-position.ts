import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { useStateWithRef } from "#src/hooks/use-state-with-ref";
import { m } from "#src/paraglide/messages";

import { ConversationBottomPin, FOLLOWING_DISTANCE_PX } from "./conversation-bottom-pin";
import type { ConversationPaneProps } from "./conversation-pane-props";
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  scrollTwice,
  type ScrollAnchor,
} from "./conversation-scroll-anchor";
import { newerPageCommit } from "./conversation-thread-search";
import { latestTopLevelSequence } from "./conversation-unread";
import type { useConversationOpen } from "./use-conversation-open";
import { useHistoryResize } from "./use-history-resize";

/** Where the reader is in one message stream: following the latest or not, and the row still
 * owed a scroll. A pane's other hooks act on it, so it comes first. */
export function useReadingPosition(
  onFollowingLatestChange: ConversationPaneProps["onFollowingLatestChange"],
) {
  const [followingLatest, followingLatestRef, setFollowingLatestState] = useStateWithRef(true);
  const setFollowingLatest = (following: boolean) => {
    if (!following) bottomPin.read();
    setFollowingLatestState(following);
    onFollowingLatestChange?.(following);
  };
  const historyRef = useRef<HTMLDivElement>(null);
  /** Bottom-follow intent and the pre-resize reading position, shared by scroll and layout events. */
  const [bottomPin] = useState(() => new ConversationBottomPin());
  /** The reading position to restore after a load changes the list's height at either end:
   * the row at the top of the viewport and its content's offset, before the change. See the
   * layout effect below for why a raw height delta is not enough once eviction is in play. */
  const historyScrollAnchorRef = useRef<ScrollAnchor | undefined>(undefined);
  // The row the pane still owes an open scroll. Rows are all in the DOM, so this is only held
  // when the container had no height to scroll within yet (a hidden branch); the pinning
  // observer retries it once the pane is laid out.
  const pendingOpenMessageIdRef = useRef<string | undefined>(undefined);

  function scrollToLatest(behavior: ScrollBehavior) {
    // Going to the latest retires any open position still owed.
    pendingOpenMessageIdRef.current = undefined;
    bottomPin.pin(historyRef.current, behavior);
  }
  return {
    historyRef,
    followingLatest,
    followingLatestRef,
    setFollowingLatest,
    bottomPin,
    historyScrollAnchorRef,
    pendingOpenMessageIdRef,
    scrollToLatest,
  };
}

/** What moves the reader as a stream changes: its open position, staying at the latest, keeping
 * the row in view when a page loads, and counting what arrives while they read further up. */
export function useStreamPositioning({
  reading,
  conversation,
  root,
  openKey,
  openBoundary,
  isOwn,
  jumpMessage,
  messageListRef,
  onLoadNewer,
  onShowLatest,
  onReadLatest,
}: {
  reading: ReturnType<typeof useReadingPosition>;
  conversation: ConversationPaneProps["conversation"];
  root: ConversationPaneProps["root"];
  openKey: string;
  openBoundary: ReturnType<typeof useConversationOpen>["boundary"];
  isOwn: (message: { senderMemberId?: string | null }) => boolean;
  jumpMessage: ConversationPaneProps["jumpMessage"];
  messageListRef: RefObject<HTMLOListElement | null>;
  onLoadNewer: ConversationPaneProps["onLoadNewer"];
  onShowLatest: ConversationPaneProps["onShowLatest"];
  onReadLatest: ConversationPaneProps["onReadLatest"];
}) {
  const {
    historyRef,
    followingLatestRef,
    setFollowingLatest,
    bottomPin,
    historyScrollAnchorRef,
    pendingOpenMessageIdRef,
    scrollToLatest,
  } = reading;
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [, loadingNewerRef, setLoadingNewer] = useStateWithRef(false);
  /** The sentinel that loads the evicted tail when it approaches the viewport (the older one is
   * `OlderMessagesRow`). */
  const newerSentinelRef = useRef<HTMLDivElement>(null);
  /** The current `loadNewer`, so the sentinel's observer never calls a stale one. */
  const loadNewerRef = useRef<() => Promise<void>>(async () => {});
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  // The row the reader is on during a newer-page fetch, refreshed as they scroll, and whether
  // that fetch started while they were following the latest. Applied once, when the fetch's own
  // commit runs — not on an unrelated message update that lands while it is in flight.
  const newerAnchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const newerStartedFollowingRef = useRef(false);
  const [newerCommit, setNewerCommit] = useState(0);
  const appliedNewerCommitRef = useRef(0);
  const lastSequence = conversation.messages.at(-1)?.sequence;
  useLayoutEffect(() => {
    const firstRender = previousConversationIdRef.current === undefined;
    const changedConversation =
      previousConversationIdRef.current !== undefined &&
      previousConversationIdRef.current !== openKey;
    const previousLastSequence = previousLastSequenceRef.current;
    const receivedMessageCount =
      previousLastSequence === undefined
        ? 0
        : conversation.messages.filter(
            (message) => !isOwn(message) && message.sequence > previousLastSequence,
          ).length;
    previousConversationIdRef.current = openKey;
    previousLastSequenceRef.current = lastSequence;
    if (firstRender || changedConversation || followingLatestRef.current) {
      setNewMessageCount(0);
      // Every ordinary conversation and thread opens on its oldest unread message. With nothing
      // unread (or no cursor), it opens at the latest. A message hash, task jump or search/Saved
      // jump still wins: the anchor and jump effects land there instead.
      const opening = firstRender || changedConversation;
      // An open with a jump target is the jump effect's to position, like a hash is the anchor
      // effect's: neither the open position nor following the latest (which scrolls a frame later)
      // may scroll over it.
      if (opening && jumpMessage && !window.location.hash) {
        setFollowingLatest(false);
        return undefined;
      }
      const openMessageId = opening ? openBoundary?.id : undefined;
      if (openMessageId && !window.location.hash) {
        if (conversation.messages.some((message) => message.id === openMessageId)) {
          setFollowingLatest(false);
          pendingOpenMessageIdRef.current = openMessageId;
          applyOpenPosition();
          return undefined;
        }
      }
      setFollowingLatest(true);
      scrollTwice(() => {
        if (followingLatestRef.current) scrollToLatest("instant");
      });
    } else if (receivedMessageCount > 0) {
      setNewMessageCount((count) => count + receivedMessageCount);
    }
    return undefined;
  }, [openKey, lastSequence]);

  useHistoryResize({
    historyRef,
    messageListRef,
    pendingOpenMessageIdRef,
    bottomPin,
    followingLatestRef,
    trackReadingPosition,
    applyOpenPosition,
    scrollToLatest,
    conversationId: conversation.conversationId,
    listIsEmpty: conversation.messages.length === 0,
  });

  // A load changes the list's height at one end and, once the window is full, removes a page at
  // the other. Restoring the anchored row keeps the reading position; see conversation-scroll-anchor.
  useLayoutEffect(() => {
    const anchor = historyScrollAnchorRef.current;
    const history = historyRef.current;
    if (!anchor || !history) return;
    historyScrollAnchorRef.current = undefined;
    restoreScrollAnchor(history, anchor);
  }, [conversation.messages]);

  useLayoutEffect(() => {
    if (newerCommit === appliedNewerCommitRef.current) return;
    appliedNewerCommitRef.current = newerCommit;
    const startedFollowing = newerStartedFollowingRef.current;
    const anchor = newerAnchorRef.current;
    newerStartedFollowingRef.current = false;
    newerAnchorRef.current = undefined;
    if (newerPageCommit(startedFollowing, followingLatestRef.current) === "pin-bottom") {
      scrollTwice(() => scrollToLatest("instant"));
      return;
    }
    restoreScrollAnchor(historyRef.current, anchor);
  }, [newerCommit]);

  // The mirror sentinel below the newest row: once the bounded window has slid up into history and
  // evicted the tail, scrolling back to the bottom asks for the page that brings it back. It re-runs
  // on every message change so a fetch that leaves the sentinel still in view keeps going until the
  // tail is loaded (an IntersectionObserver only fires on a crossing, not while it stays visible).
  useEffect(() => {
    const sentinel = newerSentinelRef.current;
    const history = historyRef.current;
    if (!sentinel || !history) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNewerRef.current();
      },
      { root: history, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.hasNewer, conversation.messages.length]);

  useLayoutEffect(() => {
    if (!pendingLatestRef.current || conversation.hasNewer) return;
    scrollTwice(() => scrollToLatest("instant"));
    pendingLatestRef.current = false;
  }, [conversation.hasNewer, conversation.messages]);

  /** Scrolls to the row the pane opens on — the oldest unread, or the latest. Runs once per open;
   * the pinning observer retries it if the pane had no height to scroll within yet. */
  function applyOpenPosition() {
    const messageId = pendingOpenMessageIdRef.current;
    if (messageId === undefined) return;
    const history = historyRef.current;
    // The whole row, not the message body inside it: the unread divider and the day divider are
    // drawn at the top of the row, and anchoring on the body would scroll them off the top —
    // Slack's default is to open on the first unread *and* show its divider.
    const row = history?.querySelector(`li[data-message-id="${CSS.escape(messageId)}"]`);
    if (!history || !row || history.clientHeight === 0) return;
    pendingOpenMessageIdRef.current = undefined;
    // A row that lands at the bottom follows the latest from there (`ConversationBottomPin.open`).
    scrollTwice(() => {
      if (bottomPin.open(history, row)) setFollowingLatest(true);
    });
  }

  loadNewerRef.current = () => loadNewer();

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    // Loading older history is the top sentinel's job (`OlderMessagesRow`), not this scroll
    // handler's.
    const distance = bottomPin.scroll(history);
    if (distance === undefined) return;
    const followingLatest = distance <= FOLLOWING_DISTANCE_PX;
    const wasFollowingLatest = followingLatestRef.current;
    setFollowingLatest(followingLatest);
    // A newer page is about to change both ends of the list. Keep the snapshot on the row they
    // have scrolled to, not the row where the fetch started.
    if (loadingNewerRef.current) newerAnchorRef.current = captureScrollAnchor(history);
    if (followingLatest) setNewMessageCount(0);
    // A genuine scroll transition into the latest run is the only signal that the user read
    // through it. Open positioning sets `followingLatest` directly and never passes through here.
    if (followingLatest && !wasFollowingLatest && !root) {
      const through = latestTopLevelSequence(conversation.messages);
      if (through > 0) onReadLatest?.(through);
    }
  }

  async function loadNewer() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasNewer || !onLoadNewer || loadingNewerRef.current)
      return;
    setLoadingNewer(true);
    newerStartedFollowingRef.current = followingLatestRef.current;
    newerAnchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadNewer();
      setNewerCommit((commit) => commit + 1);
    } catch {
      newerAnchorRef.current = undefined;
      newerStartedFollowingRef.current = false;
    } finally {
      setLoadingNewer(false);
    }
  }

  async function showLatestMessages() {
    setFollowingLatest(true);
    setNewMessageCount(0);
    if (conversation.hasNewer && onShowLatest) {
      pendingLatestRef.current = true;
      try {
        await onShowLatest();
      } catch {
        pendingLatestRef.current = false;
        setFollowingLatest(false);
        toast.error(m.conversation_history_load_error());
        return;
      }
    }
    scrollToLatest("smooth");
  }

  return { newMessageCount, newerSentinelRef, trackReadingPosition, showLatestMessages };
}
