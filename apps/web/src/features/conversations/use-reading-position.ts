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
  const [bottomPin] = useState(() => new ConversationBottomPin());
  const historyScrollAnchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const pendingOpenMessageIdRef = useRef<string | undefined>(undefined);

  function scrollToLatest(behavior: ScrollBehavior) {
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

export function useStreamPositioning({
  reading,
  conversation,
  root,
  openKey,
  openBoundary,
  openAtTop,
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
  openAtTop: boolean;
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
  const [, loadingNewerRef, setLoadingNewer] = useStateWithRef(false);
  const newerSentinelRef = useRef<HTMLDivElement>(null);
  const loadNewerRef = useRef<() => Promise<void>>(async () => {});
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
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
    previousConversationIdRef.current = openKey;
    if (firstRender || changedConversation || followingLatestRef.current) {
      const opening = firstRender || changedConversation;
      if (opening && jumpMessage && !window.location.hash) {
        setFollowingLatest(false);
        return undefined;
      }
      if (opening && openAtTop && !window.location.hash) {
        setFollowingLatest(false);
        scrollTwice(() => historyRef.current?.scrollTo({ top: 0 }));
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

  const [latestInView, setLatestInView] = useState(false);
  const readLatestRef = useRef<() => void>(() => {});
  readLatestRef.current = () => {
    const through = latestTopLevelSequence(conversation.messages);
    if (through > 0) onReadLatest?.(through);
  };
  const latestId = conversation.messages.at(-1)?.id;
  useEffect(() => {
    const history = historyRef.current;
    const latest =
      latestId &&
      messageListRef.current?.querySelector(`li[data-message-id="${CSS.escape(latestId)}"]`);
    if (!openAtTop || root || !history || !latest) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const inView = entries.some((entry) => entry.isIntersecting);
        setLatestInView(inView);
        if (inView) readLatestRef.current();
      },
      { root: history },
    );
    observer.observe(latest);
    return () => observer.disconnect();
  }, [openAtTop, root, latestId]);

  useLayoutEffect(() => {
    if (!pendingLatestRef.current || conversation.hasNewer) return;
    scrollTwice(() => scrollToLatest("instant"));
    pendingLatestRef.current = false;
  }, [conversation.hasNewer, conversation.messages]);

  function applyOpenPosition() {
    const messageId = pendingOpenMessageIdRef.current;
    if (messageId === undefined) return;
    const history = historyRef.current;
    const row = history?.querySelector(`li[data-message-id="${CSS.escape(messageId)}"]`);
    if (!history || !row || history.clientHeight === 0) return;
    pendingOpenMessageIdRef.current = undefined;
    scrollTwice(() => {
      if (bottomPin.open(history, row)) setFollowingLatest(true);
    });
  }

  loadNewerRef.current = () => loadNewer();

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    const distance = bottomPin.scroll(history);
    if (distance === undefined) return;
    const followingLatest = distance <= FOLLOWING_DISTANCE_PX;
    const wasFollowingLatest = followingLatestRef.current;
    setFollowingLatest(followingLatest);
    if (loadingNewerRef.current) newerAnchorRef.current = captureScrollAnchor(history);
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

  return { newerSentinelRef, trackReadingPosition, showLatestMessages, latestInView };
}
