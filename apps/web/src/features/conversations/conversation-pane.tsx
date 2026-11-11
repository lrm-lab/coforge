import { WorkspaceAssistantWelcome } from "./workspace-assistant-welcome";
import { useCallback, useMemo, useRef, useState } from "react";
import { useLatestCallback } from "#src/hooks/use-latest-callback";

import { useAppToast } from "#src/components/ui/toast";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { useSavedMessages } from "./conversation-host";
import { OlderMessagesRow } from "./older-messages-row";
import { useLoadOlder } from "./use-load-older";
import { streamState } from "./stream-state";
import { ConversationComposerFooter } from "./conversation-composer-footer";
import { ThreadPaneHeader } from "./thread-pane-header";
import { makeReferenceBodyFormatter } from "./mention-text";
import { dayLabel } from "./message-row";
import { outboxContinuesRun } from "./conversation-pane-layout";
import { useMessageExpansion } from "./use-message-expansion";
import { optimisticSavedEntry } from "./saved-messages-collection";
import { groupSystemMessages } from "./system-message-groups";
import { usePaneOutbox } from "./use-pane-outbox";
import { ComposerEdgeOverlay } from "./composer-edge-overlay";
import { ConversationMessageList } from "./conversation-message-list";
import { NewerSentinel } from "./conversation-newer-sentinel";
import { useOwnMessagesIndex } from "./own-messages-menu";
import { useLoadedOwnMessages } from "./use-loaded-own-messages";
import { isViewerMessage } from "./own-message";
import { useConversationOpen } from "./use-conversation-open";
import { useSystemMessageGroups } from "./use-system-message-groups";
import { useMessageJump } from "./use-message-jump";
import { useReadingPosition, useStreamPositioning } from "./use-reading-position";
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
  const reading = useReadingPosition(onFollowingLatestChange);
  const {
    historyRef,
    followingLatest,
    setFollowingLatest,
    bottomPin,
    historyScrollAnchorRef,
    scrollToLatest,
  } = reading;
  const messageListRef = useRef<HTMLOListElement>(null);
  const { olderLoad, loadOlder } = useLoadOlder({
    historyRef,
    anchorRef: historyScrollAnchorRef,
    enabled: !root && conversation.hasOlder,
    onLoadOlder,
  });
  // The initial position and divider are captured once per conversation or thread open.
  const { boundary: openBoundary, openKey } = useConversationOpen(
    conversation,
    root?.id,
    followingLatest,
    { keepsCursor: keepsReadCursor, loadAround: onLoadMessageAround },
  );
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
  const { newMessageCount, newerSentinelRef, trackReadingPosition, showLatestMessages } =
    useStreamPositioning({
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
    });

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
              <ConversationMessageList
                conversation={conversation}
                root={root}
                messageListRef={messageListRef}
                threadMarker={threadMarker}
                streamItems={streamItems}
                openedSystemMessages={openedSystemMessages}
                toggleSystemGroup={toggleSystemGroup}
                openBoundary={openBoundary}
                jumpHighlightId={jumpHighlightId}
                expandedMessages={expandedMessages}
                toggleExpandedMessage={toggleExpandedMessage}
                collapsible={collapsible}
                dateLocale={dateLocale}
                timeZone={timeZone}
                isOwn={isOwn}
                openThread={openThread}
                toggleReaction={toggleReaction}
                onToggleSave={onToggleSave}
                openAgentProfile={openAgentProfile}
                openPersonProfile={openPersonProfile}
                plainMentions={plainMentions}
                openTaskReference={openTaskReference}
                channelNames={channelNames}
                canCompose={canCompose}
                quoteSelection={quoteSelection}
                readTicks={readTicks}
                threadSeenBy={Boolean(root && conversation.readTicks)}
                shownOutbox={shownOutbox}
                outbox={outbox}
                outboxContinues={outboxContinues}
              />
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
