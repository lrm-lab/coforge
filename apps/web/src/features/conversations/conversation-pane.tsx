import { WorkspaceAssistantWelcome } from "./workspace-assistant-welcome";
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { dayLabel } from "./message-row";
import { outboxContinuesRun } from "./conversation-pane-layout";
import { ConversationUiStoreProvider, createConversationUiStore } from "./conversation-ui-store";
import { toggleExpanded } from "./conversation-view-memory";
import { MessageExpansionContext } from "./message-expansion-context";
import { optimisticSavedEntry } from "./saved-messages-collection";
import { groupSystemMessages } from "./system-message-groups";
import { usePaneOutbox } from "./use-pane-outbox";
import { ComposerEdgeOverlay } from "./composer-edge-overlay";
import { useComposerHost } from "./composer-host";
import { useComposerScope } from "./composer-scope";
import { ConversationMessageList } from "./conversation-message-list";
import { NewerSentinel } from "./conversation-newer-sentinel";
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
import { QuestionCardsHost } from "./question-card-host";
import { PaneQuoteSelection } from "./message-quote-selection";

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyState,
  streamRead = "settled",
  onSend,
  root,
  inTaskPopup = false,
  lead,
  onClose,
  threadContext,
  composerTarget,
  onViewInConversation,
  threadFollow,
  onOpenThread,
  threadHeaderAction,
  onLoadOlder,
  onLoadNewer,
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
  mentionMemberLimit,
  keepsReadCursor = true,
}: ConversationPaneProps) {
  const timeZone = useTimeZone();
  const dateLocale = getLocale();
  const toast = useAppToast();
  const [uiStore] = useState(createConversationUiStore);
  const quoteSequenceRef = useRef(0);
  const canCompose = !readOnlyNotice;
  const quoteSelection = useCallback(
    (text: string) => {
      if (!text) return;
      quoteSequenceRef.current += 1;
      const quotedDraft = { id: quoteSequenceRef.current, text };
      uiStore.setState((current) => ({ ...current, quotedDraft }));
    },
    [uiStore],
  );
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
  const paneRef = useRef<HTMLDivElement>(null);
  const { olderLoad, loadOlder } = useLoadOlder({
    historyRef,
    anchorRef: historyScrollAnchorRef,
    enabled: !root && conversation.hasOlder,
    onLoadOlder,
  });
  const { boundary: openBoundary, openKey } = useConversationOpen(
    conversation,
    root?.id,
    followingLatest,
    { keepsCursor: keepsReadCursor, loadAround: onLoadMessageAround },
  );
  const isOwn = (message: { senderMemberId?: string | null }) =>
    isViewerMessage(message, conversation.senderMemberId);
  const { outbox, outboxEntries, outboxDraftKey, shownOutbox } = usePaneOutbox({
    conversation,
    rootId: root?.id,
    onSend,
    onNewSend: () => {
      if (root) {
        setFollowingLatest(true);
        scrollToLatest("smooth");
      } else void showLatestMessages();
    },
  });
  const threadMarker =
    Boolean(root) && !inTaskPopup && conversation.messages.length + shownOutbox.length > 0;
  const outboxContinues = outboxContinuesRun(
    conversation.messages,
    isOwn,
    dayLabel,
    dateLocale,
    timeZone,
  );
  const collapsible = conversation.collapseLongMessages === true;
  const expansion = useMemo(() => ({ toggle: toggleExpanded, collapsible }), [collapsible]);
  const narrow = Boolean(root) || inTaskPopup;
  const column = !inTaskPopup;
  const composerHost = useComposerHost(root?.id, inTaskPopup);
  const composerScope = useComposerScope();
  const streamLoading = streamState(conversation.messages.length, streamRead) === "loading";
  const visibleMessages = useMemo(
    () => conversation.messages.filter((message) => message.weeklyReportHidden !== true),
    [conversation.messages],
  );
  const readTicks = root ? undefined : conversation.readTicks;
  const streamItems = useMemo(
    () =>
      groupSystemMessages(
        visibleMessages,
        (message) => inTaskPopup || message.sequence === openBoundary?.sequence,
      ),
    [visibleMessages, openBoundary, inTaskPopup],
  );
  const {
    openedMessages: openedSystemMessages,
    toggleGroup: toggleSystemGroup,
    revealGroupMessage: revealSystemMessage,
  } = useSystemMessageGroups(streamItems);
  useMessageJump({
    messages: conversation.messages,
    openedSystemMessages,
    revealSystemMessage,
    jumpMessage,
    onJumpMessageConsumed,
    onLoadMessageAround,
    setFollowingLatest,
    scrollToLatest,
    bottomPin,
    uiStore,
  });
  const { newerSentinelRef, trackReadingPosition, showLatestMessages, latestInView } =
    useStreamPositioning({
      reading,
      conversation,
      root,
      openKey,
      openBoundary,
      openAtTop: inTaskPopup,
      jumpMessage,
      messageListRef,
      onLoadNewer,
      onShowLatest,
      onReadLatest,
    });

  const cardMessages = useMemo(
    () => (root ? [root, ...visibleMessages] : visibleMessages),
    [root, visibleMessages],
  );

  const composerFooter = (
    <ConversationComposerFooter
      conversation={conversation}
      root={root}
      narrow={narrow}
      column={column}
      readOnlyNotice={readOnlyNotice}
      mentionCompletion={mentionCompletion}
      mentionMemberLimit={mentionMemberLimit}
      composerTarget={composerTarget}
      channels={channels}
      onSend={onSend}
      canSendAsTask={canSendAsTask}
      autoFocus={composerHost.autoFocus}
      hostRef={composerHost.composerRef}
    />
  );

  return (
    <ConversationUiStoreProvider store={uiStore}>
      <MessageExpansionContext.Provider value={expansion}>
        <QuestionCardsHost messages={cardMessages} paneRef={paneRef}>
          <div
            ref={paneRef}
            data-conversation-pane={narrow ? "" : "full"}
            className="flex min-h-0 flex-1 flex-col"
          >
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

            <div className="group/history relative min-h-24 flex-1 overflow-hidden">
              <div
                ref={historyRef}
                data-scroll-restoration-id={`conversation-${conversation.conversationId}${root ? `-thread-${root.id}` : ""}`}
                aria-label={root ? m.conversation_thread() : m.conversation_history()}
                onScroll={trackReadingPosition}
                onWheel={bottomPin.read}
                onTouchMove={bottomPin.read}
                onPointerDown={bottomPin.read}
                onKeyDown={bottomPin.read}
                className="h-full overflow-y-auto pb-9 [scrollbar-width:thin]"
              >
                <div className={column ? MESSAGE_COLUMN_CLASS : undefined}>
                  {lead && <div data-scroll-lead>{lead}</div>}
                  {root && !inTaskPopup && root.weeklyReportHidden !== true && (
                    <ThreadRootMessage
                      conversationId={conversation.conversationId}
                      message={root}
                      own={isOwn(root)}
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
                    <ConversationMessageList
                      conversation={conversation}
                      root={root}
                      messageListRef={messageListRef}
                      threadMarker={threadMarker}
                      streamItems={streamItems}
                      openedSystemMessages={openedSystemMessages}
                      toggleSystemGroup={toggleSystemGroup}
                      openBoundary={openBoundary}
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
              <PaneQuoteSelection
                historyRef={historyRef}
                conversationId={conversation.conversationId}
                onQuote={canCompose ? quoteSelection : undefined}
              />
              <ComposerEdgeOverlay
                column={column}
                conversationId={conversation.conversationId}
                threadRootId={root?.id ?? null}
                overhead={composerHost.overhead}
                showAgentActivity={composerHost.showAgentActivity}
                viewerId={conversation.viewerId}
                unreadCount={conversation.unreadCount}
                onlyNew={inTaskPopup}
                onShowLatest={
                  followingLatest || latestInView ? undefined : () => void showLatestMessages()
                }
              />
            </div>

            {inTaskPopup && composerScope?.composerPortal
              ? createPortal(composerFooter, composerScope.composerPortal)
              : composerFooter}
          </div>
        </QuestionCardsHost>
      </MessageExpansionContext.Provider>
    </ConversationUiStoreProvider>
  );
}
