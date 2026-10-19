import {
  messageHash,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/**
 * Where a card opens: its channel or direct conversation, at the message the stream lands on, and
 * for a thread its thread open, scrolled to the reply it opens at. The same place opens beside the
 * list on a wide screen and in Chat on a narrow one.
 *
 * A mention the viewer was notified of opens at that message, in its thread when it is a reply.
 * Any other item that mentions the viewer opens at its first mention, read or not; otherwise a
 * thread opens in its pane beside its root, scrolled to the first unread reply, and a conversation
 * opens at its first unread message, or its newest one when everything is read.
 */
export function activityOpenTarget({
  place,
  thread,
  firstUnreadMessageId,
  firstMentionMessageId,
  latest,
  mentionAction,
}: ActivityInboxItem): HostedConversationTarget {
  // A mention item is always a channel's, and never a thread item: its reply's thread is named by
  // the mention itself.
  const kind = mentionAction || place.kind === "channel" ? "channel" : "dm";
  const rootId = mentionAction ? mentionAction.threadRootId : thread?.root.id;
  const anchor = mentionAction ? latest.id : (firstMentionMessageId ?? firstUnreadMessageId);
  return rootId
    ? {
        kind,
        id: place.conversationId,
        messageId: rootId,
        threadRootId: rootId,
        threadReplyId: anchor ?? undefined,
      }
    : { kind, id: place.conversationId, messageId: anchor ?? latest.id };
}

/** The target's place in Chat, as a TanStack `Link`'s options. */
export function activityChatLink(workspaceSlug: string, target: HostedConversationTarget) {
  const search = target.threadRootId
    ? { threadRootId: target.threadRootId, message: target.messageId }
    : { message: target.messageId };
  const hash = target.threadReplyId ? messageHash(target.threadReplyId) : undefined;
  return target.kind === "channel"
    ? {
        to: "/w/$workspaceSlug/channel/$channelId" as const,
        params: { workspaceSlug, channelId: target.id },
        search,
        hash,
      }
    : {
        to: "/w/$workspaceSlug/dm/$dmId" as const,
        params: { workspaceSlug, dmId: target.id },
        search,
        hash,
      };
}

/**
 * The card that stands for what the pane shows: the thread card of the open thread, else the card
 * of the open conversation itself. One card at most, so a channel's card and its thread's card are
 * never marked together.
 */
export function openedItemKey(
  items: readonly ActivityInboxItem[],
  opened: HostedConversationTarget | undefined,
): string | undefined {
  if (!opened) return undefined;
  let conversationCard: string | undefined;
  for (const item of items) {
    if (item.place.conversationId !== opened.id) continue;
    const target = activityOpenTarget(item);
    if (target.kind !== opened.kind) continue;
    if (!target.threadRootId) conversationCard ??= item.key;
    else if (opened.threadRootId && target.threadRootId === opened.threadRootId) return item.key;
  }
  return conversationCard;
}
