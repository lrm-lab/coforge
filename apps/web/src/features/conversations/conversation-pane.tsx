import { WorkspaceAssistantWelcome } from "./workspace-assistant-welcome";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLatestCallback } from "#src/hooks/use-latest-callback";

import { useStateWithRef } from "#src/hooks/use-state-with-ref";
import { useAppToast } from "#src/components/ui/toast";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { useSavedMessages } from "./conversation-host";
import { ConversationBottomPin } from "./conversation-bottom-pin";
import { OlderMessagesRow, type OlderLoad } from "./older-messages-row";
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  scrollTwice,
  type ScrollAnchor,
} from "./conversation-scroll-anchor";
import { newerPageCommit } from "./conversation-thread-search";
import { latestTopLevelSequence } from "./conversation-unread";
import { streamState } from "./stream-state";
import { ConversationComposerFooter } from "./conversation-composer-footer";
import { ThreadPaneHeader } from "./thread-pane-header";
import { makeReferenceBodyFormatter } from "./mention-text";
import { MessageRow, dayLabel, groupsWithPrevious } from "./message-row";
import { outboxContinuesRun, ownMessageReadState } from "./conversation-pane-layout";
import { useMessageExpansion } from "./use-message-expansion";
import { optimisticSavedEntry } from "./saved-messages-collection";
import { OutboxMessageRow } from "./outbox-message-row";
import { SystemMessageGroup } from "./system-message-group";
import { groupSystemMessages, itemAnchor } from "./system-message-groups";
import { usePaneOutbox } from "./use-pane-outbox";
import { ComposerEdgeOverlay } from "./composer-edge-overlay";
import { NewerSentinel } from "./conversation-newer-sentinel";
import { useOwnMessagesIndex } from "./own-messages-menu";
import { useLoadedOwnMessages } from "./use-loaded-own-messages";
import { isViewerMessage } from "./own-message";
import { useConversationOpen } from "./use-conversation-open";
import { useSystemMessageGroups } from "./use-system-message-groups";
import { useMessageJump } from "./use-message-jump";
import { useHistoryResize } from "./use-history-resize";
import type { ConversationPaneProps } from "./conversation-pane-props";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { ConversationStreamPlaceholder } from "./conversation-stream-placeholder";
import { ThreadRepliesMarker } from "./thread-replies-marker";
import { ThreadRootMessage } from "./thread-root-message";

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyState,
  streamRead = "settled",
  onSend,
  root,
  inTaskPopup = false,
  onClose,
  threadContext,
  composerTarget,
  onViewInConversation,
  threadFollow,
  onOpenThread,
  threadHeaderAction,
  onLoadOlder,
  onLoadNewer,
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onFollowingLatestChange,
  onReadLatest,
  canSendAsTask,
  onToggleReaction,
  onOpenAgentProfile,
  onOpenPersonProfile,
  plainMentions,
  onOpenTask,
  channelNames,
  channels,
  jumpMessage,
  onJumpMessageConsumed,
  mentionCompletion = true,
  keepsReadCursor = true,
}: ConversationPaneProps) {
  // Days and times follow the viewer's locale and time zone (their saved one, else the browser's).
  // The pane is only ever rendered in the browser, so the locale is known at once.
  const timeZone = useTimeZone();
  const dateLocale = getLocale();
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  // Reply-to-selection: the row hands over a finished quote, the composer puts it in the draft.
  // The counter (never the text) is the identity of an insertion, so highlighting the same words
  // twice inserts twice.
  const [quotedDraft, setQuotedDraft] = useState<{ id: number; text: string } | undefined>();
  const quoteSequenceRef = useRef(0);
  // A read-only pane (a preview, an archived channel) offers nothing that writes a message.
  const canCompose = !readOnlyNotice;
  const quoteSelection = useCallback((text: string) => {
    if (!text) return;
    quoteSequenceRef.current += 1;
    setQuotedDraft({ id: quoteSequenceRef.current, text });
  }, []);
  // Row event handlers keep one identity across renders (`useLatestCallback`), so the memoized
  // rows skip a pane render that did not change them.
  const toggleReaction = useLatestCallback(
    onToggleReaction
      ? (messageId: string, emoji: string, active: boolean) => {
          void onToggleReaction(messageId, emoji, active).catch(() => {
            toast.error(m.conversation_reaction_error());
          });
        }
      : undefined,
  );
  const openAgentProfile = useLatestCallback(onOpenAgentProfile);
  const openPersonProfile = useLatestCallback(onOpenPersonProfile);
  const openTaskReference = useLatestCallback(onOpenTask);
  const openThread = useLatestCallback(onOpenThread);
  // Saving (#127) is viewer-global state with a conversation-scoped write: the pane owns the
  // conversation id, the Chat page's Saved context owns the list every star (and the Saved view)
  // reads. Membership-gated exactly like the channel gates its row actions; outside the Chat
  // page there is no context, so the rows simply offer no save.
  const savedMessages = useSavedMessages();
  const onToggleSave = useLatestCallback(
    savedMessages && conversation.senderMemberId
      ? async (messageId: string, saved: boolean) => {
          if (!saved) return savedMessages.unsave(messageId);
          const message =
            conversation.messages.find((candidate) => candidate.id === messageId) ??
            (root?.id === messageId ? root : undefined);
          if (!message) return;
          await savedMessages.save(optimisticSavedEntry(message, conversation.conversationId));
        }
      : undefined,
  );
  const [followingLatest, followingLatestRef, setFollowingLatestState] = useStateWithRef(true);
  const setFollowingLatest = (following: boolean) => {
    if (!following) bottomPin.read();
    setFollowingLatestState(following);
    onFollowingLatestChange?.(following);
  };
  const [olderLoad, olderLoadRef, setOlderLoad] = useStateWithRef<OlderLoad>("idle");
  const [, loadingNewerRef, setLoadingNewer] = useStateWithRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLOListElement>(null);
  /** Bottom-follow intent and the pre-resize reading position, shared by scroll and layout events. */
  const [bottomPin] = useState(() => new ConversationBottomPin());
  /** The sentinel that loads the evicted tail when it approaches the viewport (the older one is
   * `OlderMessagesRow`). */
  const newerSentinelRef = useRef<HTMLDivElement>(null);
  /** The current `loadNewer`, so the sentinel's observer never calls a stale one. */
  const loadNewerRef = useRef<() => Promise<void>>(async () => {});
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  /** The reading position to restore after a load changes the list's height at either end:
   * the row at the top of the viewport and its content's offset, before the change. See the
   * layout effect below for why a raw height delta is not enough once eviction is in play. */
  const historyScrollAnchorRef = useRef<ScrollAnchor | undefined>(undefined);
  // The row the pane still owes an open scroll. Rows are all in the DOM, so this is only held
  // when the container had no height to scroll within yet (a hidden branch); the pinning
  // observer retries it once the pane is laid out.
  const pendingOpenMessageIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  // The row the reader is on during a newer-page fetch, refreshed as they scroll, and whether
  // that fetch started while they were following the latest. Applied once, when the fetch's own
  // commit runs — not on an unrelated message update that lands while it is in flight.
  const newerAnchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const newerStartedFollowingRef = useRef(false);
  const [newerCommit, setNewerCommit] = useState(0);
  const appliedNewerCommitRef = useRef(0);
  // The initial position and divider are captured once per conversation or thread open.
  const { boundary: openBoundary, openKey } = useConversationOpen(
    conversation,
    root?.id,
    followingLatest,
    { keepsCursor: keepsReadCursor, loadAround: onLoadMessageAround },
  );
  const lastSequence = conversation.messages.at(-1)?.sequence;
  const isOwn = (message: { senderMemberId?: string | null }) =>
    isViewerMessage(message, conversation.senderMemberId);
  // Only derived from the loaded page when no indexed own-message source is wired up.
  const loadedOwnMessages = useLoadedOwnMessages(
    conversation.messages,
    conversation.senderMemberId,
    onLoadOwnMessages,
  );
  const ownIndex = useOwnMessagesIndex({
    conversationId: conversation.conversationId,
    enabled: !root,
    onLoad: onLoadOwnMessages,
    fallback: loadedOwnMessages,
  });
  // The viewer's messages the server has not confirmed yet (or failed to take), shown greyed at the
  // foot of the stream until the real message replaces them (see `composer-outbox.ts`). Only a new
  // send scrolls this pane to its latest messages.
  const { outbox, outboxEntries, outboxDraftKey, shownOutbox } = usePaneOutbox({
    conversation,
    rootId: root?.id,
    onSend,
    onSent: ownIndex.add,
    onNewSend: () => {
      if (root) {
        setFollowingLatest(true);
        scrollToLatest("smooth");
      } else void showLatestMessages();
    },
  });
  // The side pane's replies marker (the task popup puts the task in place of the root, so it has
  // none). Pending replies count: the marker is there from the first send, not after it lands.
  const threadMarker =
    Boolean(root) && !inTaskPopup && conversation.messages.length + shownOutbox.length > 0;
  // The first pending row continues the viewer's run of messages right above it, as a sent one would.
  const outboxContinues = outboxContinuesRun(
    conversation.messages,
    isOwn,
    dayLabel,
    dateLocale,
    timeZone,
  );
  // The own-messages index shows the stored body, which spells a mention as its raw
  // `<@agent:uuid>` token. Resolve those to `@handle` the way the message list does, using the
  // conversation's known mentionables. Applies to channels too (both render through here).
  const formatIndexBody = useMemo(
    () => makeReferenceBodyFormatter(conversation.mentionables ?? [], channelNames),
    [conversation.mentionables, channelNames],
  );
  /** Message ids whose very long body the reader has opened in full. Kept here rather than in the
   * row: a row is skipped and laid out again as it leaves and re-enters the viewport, and an
   * expanded message must not re-collapse behind the reader. */
  const { expandedMessages, toggleExpandedMessage } = useMessageExpansion();
  const collapsible = conversation.collapseLongMessages === true;
  // A thread, or the Task popup's discussion: a reply's composer and no stream notices.
  const narrow = Boolean(root) || inTaskPopup;
  // The message column's side room follows the pane's own width (`MESSAGE_COLUMN_CLASS` gives it
  // up in a narrow pane), so a thread beside a channel keeps none while one that fills the page, as
  // on Activity, lines up as a channel does. Only the Task popup's discussion goes without: its
  // dialog has margins of its own.
  const column = !inTaskPopup;
  // A window replacement in flight (an "around" read) has no messages yet, but that is not an
  // empty conversation: only a settled read may say so (stream-state.ts, #112/#113).
  const streamLoading = streamState(conversation.messages.length, streamRead) === "loading";
  // Runs of consecutive system messages fold into one summary line (system-message-groups.ts),
  // across days as Raft's do: a notice from a later day than its group's carries its date. A run
  // never crosses the unread divider, so the message the pane opens on (the unread boundary) is
  // always a group's first message or a row of its own.
  const visibleMessages = useMemo(
    () => conversation.messages.filter((message) => message.weeklyReportHidden !== true),
    [conversation.messages],
  );
  const readTicks = root ? undefined : conversation.readTicks;
  const streamItems = useMemo(
    () =>
      groupSystemMessages(
        visibleMessages,
        (message) => message.sequence === openBoundary?.sequence,
      ),
    [visibleMessages, openBoundary],
  );
  const {
    openedMessages: openedSystemMessages,
    toggleGroup: toggleSystemGroup,
    revealGroupMessage: revealSystemMessage,
  } = useSystemMessageGroups(streamItems);
  const { showMessage, jumpHighlightId } = useMessageJump({
    messages: conversation.messages,
    openedSystemMessages,
    revealSystemMessage,
    jumpMessage,
    onJumpMessageConsumed,
    onLoadMessageAround,
    setFollowingLatest,
    scrollToLatest,
    bottomPin,
  });
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

  function scrollToLatest(behavior: ScrollBehavior) {
    // Going to the latest retires any open position still owed.
    pendingOpenMessageIdRef.current = undefined;
    bottomPin.pin(historyRef.current, behavior);
  }

  loadNewerRef.current = () => loadNewer();

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    // Loading older history is the top sentinel's job (`OlderMessagesRow`), not this scroll
    // handler's.
    const distance = bottomPin.scroll(history);
    if (distance === undefined) return;
    const followingLatest = distance <= 48;
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

  async function loadOlder() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasOlder || !onLoadOlder) return;
    if (olderLoadRef.current === "loading") return;
    setOlderLoad("loading");
    historyScrollAnchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadOlder();
      setOlderLoad("idle");
    } catch {
      historyScrollAnchorRef.current = undefined;
      setOlderLoad("failed");
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

  return (
    <div data-conversation-pane className="flex min-h-0 flex-1 flex-col">
      {inTaskPopup ? null : root ? (
        <ThreadPaneHeader
          context={threadContext}
          onScrollToTop={() => historyRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          onClose={onClose}
          onViewInConversation={onViewInConversation}
          follow={threadFollow}
          action={threadHeaderAction}
        />
      ) : (
        header
      )}

      <div className="group/history relative min-h-0 flex-1">
        <div
          ref={historyRef}
          // The router matches restored scroll targets by a structural selector unless the
          // element names itself, and every conversation renders the same structure — so
          // without this the previous conversation's offset is applied to this one.
          data-scroll-restoration-id={`conversation-${conversation.conversationId}${root ? `-thread-${root.id}` : ""}`}
          aria-label={root ? m.conversation_thread() : m.conversation_history()}
          onScroll={trackReadingPosition}
          onWheel={bottomPin.read}
          onTouchMove={bottomPin.read}
          onPointerDown={bottomPin.read}
          onKeyDown={bottomPin.read}
          className="h-full overflow-y-auto pb-9 [scrollbar-width:thin]"
        >
          {/* The side room sits inside the scroller, so the scrollbar stays on the pane edge. */}
          <div className={column ? MESSAGE_COLUMN_CLASS : undefined}>
            {root && !inTaskPopup && root.weeklyReportHidden !== true && (
              <ThreadRootMessage
                conversationId={conversation.conversationId}
                message={root}
                own={isOwn(root)}
                expanded={expandedMessages.has(root.id)}
                onToggleExpanded={toggleExpandedMessage}
                collapsible={collapsible}
                dateLocale={dateLocale}
                onToggleReaction={toggleReaction}
                onToggleSave={onToggleSave}
                onOpenAgentProfile={openAgentProfile}
                onOpenPersonProfile={openPersonProfile}
                viewerId={conversation.viewerId}
                plainMentions={plainMentions}
                onOpenTask={openTaskReference}
                channelNames={channelNames}
                onQuoteSelection={canCompose ? quoteSelection : undefined}
              />
            )}
            {threadMarker && (
              <ThreadRepliesMarker count={visibleMessages.length + shownOutbox.length} />
            )}
            {!root && conversation.hasOlder && onLoadOlder && (
              <OlderMessagesRow
                rootRef={historyRef}
                loadedCount={conversation.messages.length}
                load={olderLoad}
                onLoad={() => void loadOlder()}
              />
            )}
            {streamLoading || (visibleMessages.length === 0 && shownOutbox.length === 0) ? (
              <ConversationStreamPlaceholder
                loading={streamLoading}
                narrow={narrow}
                emptyState={emptyState}
              />
            ) : (
              // Every loaded row is rendered, in normal flow. Nothing here computes a row's position
              // or its height, so no measurement can shift a row under the reader and no scroll
              // correction is needed while you read; the scrollbar is the real content height.
              <ol
                ref={messageListRef}
                className={cn("flex flex-col", threadMarker ? "pt-2" : "pt-6")}
              >
                {streamItems.map((item, index) => {
                  // The item above's anchor.
                  const before = streamItems[index - 1];
                  // A thread's first reply opens under the replies marker, which stands in for the
                  // day divider there; later day changes in the thread still get theirs.
                  const opensThread = threadMarker && index === 0;
                  const previous = before && itemAnchor(before);
                  const first = itemAnchor(item);
                  // The unread divider is anchored to the snapshot taken at open: once the
                  // mark-read effect has advanced the cursor, the divider must not jump.
                  const unreadStartsHere = openBoundary?.sequence === first.sequence;
                  if (item.type === "systemGroup") {
                    const groupOpen = item.messages.some((message) =>
                      openedSystemMessages.has(message.id),
                    );
                    return (
                      <SystemMessageGroup
                        key={first.id}
                        id={item.id}
                        messages={item.messages}
                        expanded={groupOpen}
                        onToggleExpanded={toggleSystemGroup}
                        dayChanged={
                          !opensThread &&
                          groupsWithPrevious(first, previous, false, false, dateLocale, timeZone)
                            .dayChanged
                        }
                        unreadStartsHere={unreadStartsHere}
                        dateLocale={dateLocale}
                      >
                        {groupOpen &&
                          item.messages.map((message) => (
                            <MessageRow
                              conversationId={conversation.conversationId}
                              key={message.id}
                              message={message}
                              own={false}
                              dayChanged={false}
                              grouped={false}
                              highlighted={message.id === jumpHighlightId}
                              expanded={false}
                              onToggleExpanded={toggleExpandedMessage}
                              collapsible={collapsible}
                              dateLocale={dateLocale}
                            />
                          ))}
                      </SystemMessageGroup>
                    );
                  }
                  const message = item.message;
                  const own = isOwn(message);
                  const { dayChanged, grouped } = groupsWithPrevious(
                    message,
                    previous,
                    own,
                    previous ? isOwn(previous) : false,
                    dateLocale,
                    timeZone,
                  );
                  return (
                    <MessageRow
                      conversationId={conversation.conversationId}
                      key={message.id}
                      message={message}
                      own={own}
                      dayChanged={dayChanged && !opensThread}
                      grouped={grouped}
                      unreadStartsHere={unreadStartsHere}
                      highlighted={message.id === jumpHighlightId}
                      expanded={expandedMessages.has(message.id)}
                      onToggleExpanded={toggleExpandedMessage}
                      collapsible={collapsible}
                      dateLocale={dateLocale}
                      onOpenThread={openThread}
                      showsTask={!root}
                      onToggleReaction={toggleReaction}
                      onToggleSave={onToggleSave}
                      onOpenAgentProfile={openAgentProfile}
                      onOpenPersonProfile={openPersonProfile}
                      viewerId={conversation.viewerId}
                      plainMentions={plainMentions}
                      onOpenTask={openTaskReference}
                      channelNames={channelNames}
                      onQuoteSelection={canCompose ? quoteSelection : undefined}
                      readState={ownMessageReadState(own, message.sequence, readTicks)}
                    />
                  );
                })}
                {shownOutbox.map((entry, index) => (
                  <OutboxMessageRow
                    key={entry.localId}
                    entry={entry}
                    grouped={index > 0 || outboxContinues}
                    composerShown={canCompose}
                    plainMentions={plainMentions}
                    viewerId={conversation.viewerId}
                    onOpenTask={openTaskReference}
                    onRetry={() => outbox.retry(entry)}
                    onEdit={() => outbox.edit(entry)}
                    onDiscard={() => outbox.remove(entry)}
                  />
                ))}
              </ol>
            )}
            {!root && canCompose && (
              <WorkspaceAssistantWelcome
                conversation={conversation}
                entries={outboxEntries}
                outbox={outbox}
                draftKey={outboxDraftKey}
              />
            )}
            {!root && conversation.hasNewer && onLoadNewer && (
              <NewerSentinel sentinelRef={newerSentinelRef} />
            )}
          </div>
        </div>
        <ComposerEdgeOverlay
          column={column}
          conversationId={conversation.conversationId}
          threadRootId={root?.id ?? null}
          navigation={{
            index: ownIndex,
            followingLatest,
            newMessageCount,
            onShowMessage: (messageId) => void showMessage(messageId),
            onShowLatest: () => void showLatestMessages(),
            formatBody: formatIndexBody,
          }}
        />
      </div>

      <ConversationComposerFooter
        conversation={conversation}
        root={root}
        narrow={narrow}
        column={column}
        readOnlyNotice={readOnlyNotice}
        mentionCompletion={mentionCompletion}
        composerTarget={composerTarget}
        channels={channels}
        onSend={onSend}
        canSendAsTask={canSendAsTask}
        onSent={ownIndex.add}
        quotedDraft={quotedDraft}
      />
    </div>
  );
}
