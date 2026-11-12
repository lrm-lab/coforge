import type { ComponentProps, RefObject } from "react";

import { cn } from "#src/lib/utils";

import { ownMessageReadState } from "./conversation-pane-layout";
import type { ConversationPaneProps } from "./conversation-pane-props";
import { MessageRow, groupsWithPrevious } from "./message-row";
import { OutboxMessageRow } from "./outbox-message-row";
import { SystemMessageGroup } from "./system-message-group";
import { itemAnchor, type StreamItem } from "./system-message-groups";
import type { usePaneOutbox } from "./use-pane-outbox";

type PaneConversation = ConversationPaneProps["conversation"];
type RowProps = ComponentProps<typeof MessageRow>;
type PaneOutbox = ReturnType<typeof usePaneOutbox>;

/**
 * The rows of one message stream: each message or folded run of system notices with its day and
 * unread dividers, then the viewer's messages not yet confirmed. The handlers keep one identity
 * across renders, so the memoized rows skip a pane render that did not change them.
 */
export function ConversationMessageList({
  conversation,
  root,
  messageListRef,
  threadMarker,
  streamItems,
  openedSystemMessages,
  toggleSystemGroup,
  openBoundary,
  jumpHighlightId,
  expandedMessages,
  toggleExpandedMessage,
  collapsible,
  dateLocale,
  timeZone,
  isOwn,
  openThread,
  toggleReaction,
  onToggleSave,
  openAgentProfile,
  openPersonProfile,
  plainMentions,
  openTaskReference,
  channelNames,
  canCompose,
  quoteSelection,
  readTicks,
  threadSeenBy,
  shownOutbox,
  outbox,
  outboxContinues,
}: {
  conversation: Pick<PaneConversation, "conversationId" | "viewerId">;
  root?: ConversationPaneProps["root"];
  messageListRef: RefObject<HTMLOListElement | null>;
  threadMarker: boolean;
  streamItems: StreamItem<PaneConversation["messages"][number]>[];
  openedSystemMessages: ReadonlySet<string>;
  toggleSystemGroup: ComponentProps<typeof SystemMessageGroup>["onToggleExpanded"];
  openBoundary?: { sequence: number };
  jumpHighlightId: string | undefined;
  expandedMessages: ReadonlySet<string>;
  toggleExpandedMessage: RowProps["onToggleExpanded"];
  collapsible: boolean;
  dateLocale: string;
  timeZone: Parameters<typeof groupsWithPrevious>[5];
  isOwn: (message: { senderMemberId?: string | null }) => boolean;
  openThread: RowProps["onOpenThread"];
  toggleReaction: RowProps["onToggleReaction"];
  onToggleSave: RowProps["onToggleSave"];
  openAgentProfile: RowProps["onOpenAgentProfile"];
  openPersonProfile: RowProps["onOpenPersonProfile"];
  plainMentions: RowProps["plainMentions"];
  openTaskReference: RowProps["onOpenTask"];
  channelNames: RowProps["channelNames"];
  canCompose: boolean;
  quoteSelection: NonNullable<RowProps["onQuoteSelection"]>;
  readTicks: PaneConversation["readTicks"];
  /** A thread pane's own replies offer who has seen them, where the conversation keeps reads. */
  threadSeenBy: boolean;
  shownOutbox: PaneOutbox["shownOutbox"];
  outbox: PaneOutbox["outbox"];
  outboxContinues: boolean;
}) {
  return (
    <ol ref={messageListRef} className={cn("flex flex-col", threadMarker ? "pt-2" : "pt-6")}>
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
          const groupOpen = item.messages.some((message) => openedSystemMessages.has(message.id));
          return (
            <SystemMessageGroup
              key={first.id}
              id={item.id}
              messages={item.messages}
              expanded={groupOpen}
              onToggleExpanded={toggleSystemGroup}
              dayChanged={
                !opensThread &&
                groupsWithPrevious(first, previous, false, false, dateLocale, timeZone).dayChanged
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
            // The row under the divider starts a sender run, so the first unread names its
            // sender even when the same sender wrote the message above (task #99).
            grouped={grouped && !unreadStartsHere}
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
            seenBy={own && threadSeenBy}
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
  );
}
