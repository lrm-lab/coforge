import {
  messageHash,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/**
 * Where a card opens: its channel or direct conversation, at the message the stream lands on, and
 * for a thread its thread open, scrolled to the reply it opens at. On Activity a thread opens alone
 * (`threadAlone`), without the conversation around it; in Chat (`activityChatLink`, a modified
 * click) the same place opens the thread beside its root.
 *
 * A mention the viewer was notified of opens at that message, in its thread when it is a reply.
 * Any other item opens at its first unread message (a thread at its first unread reply), where the
 * pane draws its "New messages" divider (task #358). With nothing unread, an item that mentions the
 * viewer opens at its first mention, read or not (#1129), and any other at its newest message. A
 * Task's conversation opens as its popup over the board it is on. A comment on a file opens the
 * file's conversation at the message it rides on, with the file's review over it at the comment.
 */
export function activityOpenTarget({
  place,
  thread,
  task,
  firstUnreadMessageId,
  firstMentionMessageId,
  latest,
  mentionAction,
  attachmentComment,
}: ActivityInboxItem): HostedConversationTarget {
  if (task) return { kind: "channel", id: place.conversationId, task: task.number };
  // A comment notification opens the file's own conversation, at the message the file rides on
  // (the comment itself lives in a conversation the UI never shows), and the file's review at the
  // comment: the comments list holds only top-level comments, so a reply is reached through the
  // comment it answers. A file with no message opens the conversation plainly.
  if (attachmentComment)
    return {
      kind: place.kind === "channel" ? "channel" : "dm",
      id: place.conversationId,
      ...(attachmentComment.sourceMessageId
        ? { messageId: attachmentComment.sourceMessageId }
        : {}),
      attachmentId: attachmentComment.attachmentId,
      commentId: attachmentComment.threadRootId ?? latest.id,
    };
  // A mention item is always a channel's, and never a thread item: its reply's thread is named by
  // the mention itself.
  const kind = mentionAction || place.kind === "channel" ? "channel" : "dm";
  const rootId = mentionAction ? mentionAction.threadRootId : thread?.root.id;
  // A read mention before newer unread messages must not pull the pane back to it, away from
  // what is new.
  const anchor = mentionAction ? latest.id : (firstUnreadMessageId ?? firstMentionMessageId);
  return rootId
    ? {
        kind,
        id: place.conversationId,
        messageId: rootId,
        threadRootId: rootId,
        threadReplyId: anchor ?? undefined,
        threadAlone: true,
      }
    : { kind, id: place.conversationId, messageId: anchor ?? latest.id };
}

/** The target's place in Chat, as a TanStack `Link`'s options. */
export function activityChatLink(workspaceSlug: string, target: HostedConversationTarget) {
  const search = target.threadRootId
    ? { threadRootId: target.threadRootId, message: target.messageId }
    : {
        message: target.messageId,
        task: target.task,
        file: target.attachmentId,
        comment: target.commentId,
      };
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
 * The card that stands for what the pane shows: the Task card of the open Task popup, the thread
 * card of the open thread, else the card of the open conversation itself. One card at most, so a
 * channel's card and its thread's card are never marked together.
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
    if (target.task !== undefined) {
      if (target.task === opened.task) return item.key;
    } else if (!target.threadRootId) conversationCard ??= item.key;
    else if (opened.threadRootId && target.threadRootId === opened.threadRootId) return item.key;
  }
  return conversationCard;
}
