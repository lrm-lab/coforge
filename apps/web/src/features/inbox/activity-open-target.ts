import {
  messageHash,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import type { WaitingChoiceCard } from "#src/server/conversations/waiting-choice-cards.server";
import type {
  ActivityConversationItem,
  ActivityInboxItem,
} from "#src/server/inbox/activity-inbox.server";

export function activityOpenTarget({
  place,
  thread,
  task,
  firstUnreadMessageId,
  firstMentionMessageId,
  latest,
  mentionAction,
  attachmentComment,
}: ActivityConversationItem): HostedConversationTarget {
  const anchor = mentionAction ? latest.id : (firstUnreadMessageId ?? firstMentionMessageId);
  if (task)
    return {
      kind: "channel",
      id: place.conversationId,
      task: task.number,
      taskAlone: true,
      messageId: anchor ?? latest.id,
    };
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
  const kind = mentionAction || place.kind === "channel" ? "channel" : "dm";
  const rootId = mentionAction ? mentionAction.threadRootId : thread?.root.id;
  if (rootId) return threadAlone(kind, place.conversationId, rootId, anchor ?? undefined);
  const unreadFrom = !mentionAction && firstUnreadMessageId ? firstUnreadMessageId : undefined;
  return {
    kind,
    id: place.conversationId,
    messageId: anchor ?? latest.id,
    ...(unreadFrom ? { unreadFrom } : {}),
  };
}

function threadAlone(
  kind: "channel" | "dm",
  conversationId: string,
  rootId: string,
  replyId: string | undefined,
): HostedConversationTarget {
  return {
    kind,
    id: conversationId,
    messageId: rootId,
    threadRootId: rootId,
    threadReplyId: replyId,
    threadAlone: true,
  };
}

export function waitingChoiceTarget(card: WaitingChoiceCard): HostedConversationTarget {
  if (card.task)
    return {
      kind: "channel",
      id: card.task.conversationId,
      task: card.task.number,
      taskAlone: true,
      messageId: card.messageId,
    };
  const kind = card.channel ? "channel" : "dm";
  return card.threadRootId
    ? threadAlone(kind, card.conversationId, card.threadRootId, card.messageId)
    : { kind, id: card.conversationId, messageId: card.messageId };
}

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

export function openedItemKey(
  items: readonly ActivityInboxItem[],
  opened: HostedConversationTarget | undefined,
): string | undefined {
  if (!opened) return undefined;
  let conversationCard: string | undefined;
  for (const item of items) {
    if (item.kind !== "conversation" || item.place.conversationId !== opened.id) continue;
    const target = activityOpenTarget(item);
    if (target.kind !== opened.kind) continue;
    if (target.task !== undefined) {
      if (target.task === opened.task) return item.key;
    } else if (!target.threadRootId) conversationCard ??= item.key;
    else if (opened.threadRootId && target.threadRootId === opened.threadRootId) return item.key;
  }
  return conversationCard;
}
