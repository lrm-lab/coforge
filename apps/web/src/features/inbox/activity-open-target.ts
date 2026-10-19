import type { ConversationPageTarget } from "#src/features/conversations/conversation-page-loader";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/**
 * Where a card opens: its channel or direct conversation, at the message the stream lands on, and
 * for a thread its thread open, scrolled to the reply it opens at. The same place opens beside the
 * list on a wide screen and in Chat on a narrow one.
 */
export type ActivityOpenTarget = ConversationPageTarget & {
  messageId: string;
  threadRootId?: string;
  /** The reply the open thread scrolls to. */
  threadReplyId?: string;
};

/**
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
}: ActivityInboxItem): ActivityOpenTarget {
  if (mentionAction) {
    const { threadRootId } = mentionAction;
    return threadRootId
      ? {
          kind: "channel",
          id: place.conversationId,
          messageId: threadRootId,
          threadRootId,
          threadReplyId: latest.id,
        }
      : { kind: "channel", id: place.conversationId, messageId: latest.id };
  }
  const kind = place.kind === "channel" ? "channel" : "dm";
  const anchor = firstMentionMessageId ?? firstUnreadMessageId;
  return thread
    ? {
        kind,
        id: place.conversationId,
        messageId: thread.root.id,
        threadRootId: thread.root.id,
        threadReplyId: anchor ?? undefined,
      }
    : { kind, id: place.conversationId, messageId: anchor ?? latest.id };
}

/** The target's place in Chat, as a TanStack `Link`'s options. */
export function activityChatLink(workspaceSlug: string, target: ActivityOpenTarget) {
  const search = target.threadRootId
    ? { threadRootId: target.threadRootId, message: target.messageId }
    : { message: target.messageId };
  const hash = target.threadReplyId ? `message-${target.threadReplyId}` : undefined;
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

/** The Activity URL's `open` param for a target: `channel:<id>` or `dm:<id>`. */
export function activityOpenParam(target: ConversationPageTarget): string {
  return `${target.kind}:${target.id}`;
}

/** The conversation the Activity URL's `open` param names, if any. */
export function parseActivityOpenParam(
  open: string | undefined,
): ConversationPageTarget | undefined {
  const [kind, id] = open?.split(":") ?? [];
  return (kind === "channel" || kind === "dm") && id ? { kind, id } : undefined;
}

/**
 * The card that stands for what the pane shows: the thread card of the open thread, else the card
 * of the open conversation itself. One card at most, so a channel's card and its thread's card are
 * never marked together.
 */
export function openedItemKey(
  items: readonly ActivityInboxItem[],
  opened: (ConversationPageTarget & { threadRootId?: string }) | undefined,
): string | undefined {
  if (!opened) return undefined;
  const inOpened = items
    .map((item) => ({ item, target: activityOpenTarget(item) }))
    .filter(({ target }) => target.kind === opened.kind && target.id === opened.id);
  const threadCard = opened.threadRootId
    ? inOpened.find(({ target }) => target.threadRootId === opened.threadRootId)
    : undefined;
  return (threadCard ?? inOpened.find(({ target }) => !target.threadRootId))?.item.key;
}
