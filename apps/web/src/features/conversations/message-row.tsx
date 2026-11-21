import { actionCardPreviewText } from "./action-card-preview";
import { memo } from "react";
import { WeeklyReportMessageCard } from "#src/features/records/weekly-report-message-card";

import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ActionCard } from "./action-card";
import { MessageSenderLine } from "./message-sender-line";
import { attachmentMessageDisplayBody } from "./attachment-file-name";
import {
  MessageArtifactCards,
  useMessageArtifactLayout,
} from "#src/features/artifacts/artifact-card";
import { ArtifactInlineEmbed } from "#src/features/artifacts/artifact-inline-embed";
import { CollapsibleMessageBody } from "./collapsible-message-body";
import type { ChipMention } from "./message-reference-chips";
import { messagePlainText } from "./selection-copy";
import { QuoteSelectionBar, useQuoteSelection } from "./message-quote-selection";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { clockLabel } from "#src/lib/dates";
import { gutterClockLabel } from "./gutter-clock-label";
import { DayDivider, UnreadDivider, dayLabel } from "./message-dividers";
import { SystemMessageRow } from "./system-message-row";
import { MessageRowFooter } from "./message-row-footer";
import { OwnMessageTicks } from "./message-status-markers";
import { MessageSenderGutter } from "./message-sender-gutter";
import { MessageActionSheet, MessageActionToolbar } from "./message-actions";
import { useMessageRowActions } from "./message-row-actions";
import { useRowSelection } from "./message-selection";
import { ForwardedMessageCard } from "./message-forward-card";
import { ReviewLanding } from "./attachment-review-address";
import type { MessageView } from "./message-view";
import type { ReadState } from "./conversation-pane-layout";

export { dayLabel };
export { groupsWithPrevious } from "./message-view";

export const ROW_CLASS = "flex flex-col";
export const RUN_START_CLASS = "mt-2 first:mt-0 md:mt-4 [[data-message-row]+&]:mt-0";
export const messagePaddingClass = (grouped: boolean) =>
  cn(
    grouped ? "pt-0.5" : "pt-3 md:[[data-message-row]+[data-message-row=start]>&]:pt-4",
    "pb-1 [li:has(+[data-message-row=continue])>&]:pb-0.5 [li:has(+[data-message-row=start])>&]:pb-3 md:[li:has(+[data-message-row=start])>&]:pb-4",
  );
export const messageRowKind = (grouped: boolean, divided = false) =>
  grouped ? "continue" : divided ? "divided" : "start";

export const MessageRow = memo(function MessageRow({
  message,
  conversationId,
  showsTask = false,
  own,
  dayChanged,
  grouped,
  expanded,
  onToggleExpanded,
  collapsible = true,
  unreadStartsHere,
  highlighted,
  dateLocale,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  onOpenAgentProfile,
  onOpenPersonProfile,
  viewerId,
  plainMentions,
  onOpenTask,
  channelNames,
  onQuoteSelection,
  readState,
  seenBy,
}: {
  message: MessageView;
  conversationId?: string;
  own: boolean;
  dayChanged: boolean;
  grouped: boolean;
  expanded: boolean;
  onToggleExpanded: (messageId: string) => void;
  collapsible?: boolean;
  unreadStartsHere?: boolean;
  highlighted?: boolean;
  dateLocale?: string;
  onOpenThread?: (rootId: string) => void;
  showsTask?: boolean;
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => void;
  onToggleSave?: (messageId: string, saved: boolean) => Promise<void>;
  onOpenAgentProfile?: OpenAgentProfile;
  onOpenPersonProfile?: OpenPersonProfile;
  viewerId?: string;
  plainMentions?: Map<string, ChipMention>;
  onOpenTask?: (number: number) => void;
  channelNames?: ReadonlyMap<string, string>;
  onQuoteSelection?: (quote: string) => void;
  readState?: ReadState;
  seenBy?: boolean;
}) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const displayName = own ? m.conversation_you() : message.senderName;
  const deleted = Boolean(message.senderDeleted);
  const openableAgentId =
    !own && message.senderKind === "agent" && message.senderAgentId && onOpenAgentProfile
      ? message.senderAgentId
      : undefined;
  const openablePersonId =
    message.senderKind === "user" && message.senderUserId && onOpenPersonProfile
      ? message.senderUserId
      : undefined;
  const openSenderProfile = openableAgentId
    ? () => onOpenAgentProfile?.(openableAgentId)
    : openablePersonId
      ? () => onOpenPersonProfile?.(openablePersonId)
      : undefined;
  const avatar =
    message.senderKind === "agent" && message.senderAgentId ? (
      <ActorAvatar
        size="sm"
        presence
        agentId={message.senderAgentId}
        name={message.senderName}
        src={message.senderAvatarUrl}
        deleted={deleted}
      />
    ) : (
      <ActorAvatar
        presence
        size="sm"
        userId={message.senderUserId}
        name={message.senderName}
        src={message.senderAvatarUrl}
        deleted={deleted}
      />
    );
  const quoteSelection = useQuoteSelection({
    onQuoteSelection,
    author: displayName,
    time: clockLabel(message.createdAt, dateLocale, timeFormat, timeZone),
  });
  const { actions, copyable, hasActions, sheetActions, actionsOpen, setActionsOpen, openActions } =
    useMessageRowActions({
      message,
      conversationId,
      channelNames,
      readState,
      seenBy,
      onOpenThread,
      onToggleReaction,
      onToggleSave,
      inStream: showsTask,
    });
  const selection = useRowSelection({ message, conversationId, channelNames, inStream: showsTask });
  const writtenBody = attachmentMessageDisplayBody(message);
  const artifactLayout = useMessageArtifactLayout(writtenBody, message.artifactCards);
  const displayBody = artifactLayout.displayBody;
  if (message.senderKind === "system")
    return (
      <SystemMessageRow
        message={message}
        unreadStartsHere={unreadStartsHere}
        dayChanged={dayChanged}
        highlighted={highlighted}
        dateLocale={dateLocale}
      />
    );
  const showsBody = !message.forwarded || writtenBody.trim() !== "";
  const textTicks =
    readState && !message.actionCard && artifactLayout.hasText ? (
      <OwnMessageTicks readState={readState} inline />
    ) : undefined;
  const hasInFlowEmbeds = artifactLayout.inlineEmbedIds.size > 0;
  return (
    <li
      data-message-id={message.id}
      data-message-row={messageRowKind(grouped, dayChanged || unreadStartsHere)}
      className={cn(
        ROW_CLASS,
        !grouped && !dayChanged && !unreadStartsHere && RUN_START_CLASS,
        grouped && "[li:has([data-thread-preview])+&]:mt-3",
      )}
    >
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={message.createdAt} locale={dateLocale} />}
      <div
        id={`message-${message.id}`}
        data-message={own ? "own" : "other"}
        onClick={selection?.onClick ?? openActions}
        className={cn(
          "group/message relative mx-1 flex scroll-m-6 rounded-lg px-3 transition-[background-color,box-shadow] duration-500 hover:bg-message-hover focus-within:bg-message-hover target:bg-tertiary target:ring-2 target:ring-brand/50 target:ring-offset-0 target:ring-offset-primary md:target:ring-offset-2 md:mx-3",
          highlighted &&
            "bg-tertiary ring-2 ring-brand/50 ring-offset-0 ring-offset-primary md:ring-offset-2",
          "gap-3",
          messagePaddingClass(grouped),
          selection?.selected && "bg-tertiary hover:bg-tertiary focus-within:bg-tertiary",
        )}
      >
        {selection?.checkbox}
        <MessageSenderGutter
          message={message}
          grouped={grouped}
          conversationId={conversationId}
          openableAgentId={openableAgentId}
          openablePersonId={openablePersonId}
          onOpenAgentProfile={onOpenAgentProfile}
          openSenderProfile={openSenderProfile}
          avatar={avatar}
          gutterTime={gutterClockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
          fullTime={clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
        />
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5 has-[[data-read-ticks=latest]]:pr-5 lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[data-read-ticks=hover]]:pr-5">
          {!grouped && (
            <MessageSenderLine
              message={message}
              displayName={displayName}
              deleted={deleted}
              onOpenSender={openSenderProfile}
              time={clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
            />
          )}
          {message.actionCard ? (
            <>
              <span className="sr-only">
                {actionCardPreviewText(
                  message.actionCard.preview && {
                    ...message.actionCard.preview,
                    hint: message.actionCard.draftHint,
                  },
                ) || message.body}
              </span>
              <ActionCard card={message.actionCard} asker={message.senderName} />
            </>
          ) : showsBody ? (
            <div
              ref={quoteSelection.bodyRef}
              data-scroll-anchor
              onMouseUp={quoteSelection.read}
              onKeyUp={quoteSelection.read}
              className="relative min-w-0 text-md text-primary [overflow-wrap:anywhere]"
            >
              {hasInFlowEmbeds ? (
                <div className="flex flex-col gap-1.5">
                  {artifactLayout.segments.map((segment, index) => {
                    if (segment.kind === "embed") {
                      const card = artifactLayout.cardsById.get(segment.link.id);
                      if (!card) return null;
                      return (
                        <ArtifactInlineEmbed
                          key={`embed:${segment.link.id}`}
                          card={card}
                          version={segment.link.version}
                          selectionActive={Boolean(selection)}
                        />
                      );
                    }
                    return (
                      <CollapsibleMessageBody
                        key={`text:${index}`}
                        body={segment.text}
                        trailing={index === artifactLayout.lastTextIndex ? textTicks : undefined}
                        mentions={message.mentions}
                        plainMentions={plainMentions}
                        viewerId={viewerId}
                        onOpenTask={onOpenTask}
                        channelNames={channelNames}
                        onOpenAgentProfile={onOpenAgentProfile}
                        onOpenPersonProfile={onOpenPersonProfile}
                        expanded={expanded}
                        collapsible={collapsible && index === artifactLayout.longestTextIndex}
                        onToggleExpanded={() => onToggleExpanded(message.id)}
                      />
                    );
                  })}
                </div>
              ) : (
                <CollapsibleMessageBody
                  body={displayBody}
                  trailing={textTicks}
                  mentions={message.mentions}
                  plainMentions={plainMentions}
                  viewerId={viewerId}
                  onOpenTask={onOpenTask}
                  channelNames={channelNames}
                  onOpenAgentProfile={onOpenAgentProfile}
                  onOpenPersonProfile={onOpenPersonProfile}
                  expanded={expanded}
                  collapsible={collapsible}
                  onToggleExpanded={() => onToggleExpanded(message.id)}
                />
              )}
              <MessageArtifactCards
                body={message.body}
                links={artifactLayout.trailingLinks}
                states={message.artifactCards}
                selectionActive={Boolean(selection)}
              />
              {message.weeklyReportSuggestion ? (
                <WeeklyReportMessageCard
                  messageId={message.id}
                  suggestion={message.weeklyReportSuggestion}
                  onOpenAgentProfile={onOpenAgentProfile}
                  disabled={deleted}
                />
              ) : null}
              {onQuoteSelection && (
                <QuoteSelectionBar selection={quoteSelection} onQuote={onQuoteSelection} />
              )}
            </div>
          ) : null}
          <ReviewLanding value={message.threadRootId ? undefined : message.id}>
            {message.forwarded && (
              <ForwardedMessageCard
                forwarded={message.forwarded}
                attachments={message.attachments}
                messageId={message.id}
              />
            )}
            <MessageRowFooter
              message={message.forwarded ? { ...message, attachments: [] } : message}
              viewerId={viewerId}
              onToggleReaction={
                onToggleReaction && ((emoji, active) => onToggleReaction(message.id, emoji, active))
              }
              showsTask={showsTask}
              onOpenTask={onOpenTask}
              onOpenThread={onOpenThread}
              cornerTicks={textTicks ? undefined : readState}
            />
          </ReviewLanding>
        </div>
        {hasActions && !selection && <MessageActionToolbar {...actions} grouped={grouped} />}
        {sheetActions && hasActions && (
          <MessageActionSheet
            {...actions}
            isOpen={actionsOpen}
            onOpenChange={setActionsOpen}
            avatar={avatar}
            displayName={displayName}
            createdAt={message.createdAt}
            time={clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
            plainText={messagePlainText(message, channelNames)}
            copyable={copyable}
          />
        )}
      </div>
    </li>
  );
});
