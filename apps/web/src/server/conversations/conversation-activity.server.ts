import type { PrismaClient } from "#src/generated/prisma/client";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-realtime";
import { BROWSER_MESSAGE_MENTIONS_SELECT, browserMessageMention } from "./mentions.server";
import { messagePreviewLine } from "./message-preview-line.server";
import { browserSenderName } from "./sender-display.server";
import type {
  ConversationRealtime,
  ConversationRealtimeMessage,
} from "./conversation-realtime.server";

/**
 * The recipients of one message's `conversation.activity.v1`: the people who may read it and whose
 * sidebar or Activity dot it may move. A channel's active human members; for a thread reply, the
 * thread's human followers instead (a reply never changes a row, and only a follower's Activity
 * lists the thread); for a direct conversation, the people already named by its signal scope.
 *
 * The viewer's own message is in the list: their other tabs and devices must move the row too, and
 * the page is what ignores it for the badge.
 */
async function activityRecipients(
  db: PrismaClient,
  message: ConversationRealtimeMessage,
): Promise<string[]> {
  if (message.threadRootId) {
    const followers = await db.threadFollow.findMany({
      where: { rootMessageId: message.threadRootId, conversationId: message.conversationId },
      select: { member: { select: { userId: true } } },
    });
    return [...new Set(followers.flatMap((row) => (row.member.userId ? [row.member.userId] : [])))];
  }
  if (message.directUserIds) return [...new Set(message.directUserIds)];
  if (message.userId) return [message.userId];
  const members = await db.conversationMember.findMany({
    where: { conversationId: message.conversationId, leftAt: null, userId: { not: null } },
    select: { userId: true },
  });
  return [...new Set(members.flatMap((row) => (row.userId ? [row.userId] : [])))];
}

/**
 * Announces one new message: to its conversation's own channel, for the open page to reconcile,
 * and as `conversation.activity.v1` to each recipient's own channel, which is what moves the Chat
 * sidebar's row and the unread and Activity counts without a read.
 *
 * Runs after the write commits, never inside its transaction or its locks: the reads here are one
 * for the message (its body, sender and mentions, for the row's preview) and one for the
 * recipients. A failure is the caller's to swallow, as every realtime publish is: PostgreSQL stays
 * canonical and the browser's reconciliation repairs what a missed publication left.
 */
export async function announceMessage(
  db: PrismaClient | undefined,
  realtime: Pick<ConversationRealtime, "messageAvailable" | "conversationActivity"> | undefined,
  message: ConversationRealtimeMessage,
): Promise<void> {
  if (!realtime) return;
  await realtime.messageAvailable(message);
  if (!db || !realtime.conversationActivity) return;
  const stored = await db.message.findUnique({
    where: { id: message.messageId },
    select: {
      body: true,
      createdAt: true,
      threadRootId: true,
      workspaceId: true,
      conversation: { select: { channelName: true } },
      sender: {
        select: {
          userId: true,
          agentId: true,
          user: { select: { displayName: true, username: true } },
          agent: { select: { name: true, displayName: true } },
        },
      },
      mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
    },
  });
  if (!stored) return;
  const event: ConversationActivityEvent = {
    type: "conversation.activity.v1",
    workspaceId: stored.workspaceId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    sequence: message.sequence,
    kind: stored.conversation.channelName === null ? "direct" : "channel",
    createdAt: stored.createdAt.toISOString(),
    preview: messagePreviewLine(
      stored.body,
      stored.mentions.map((mention) => browserMessageMention(mention)),
    ),
    sender: {
      kind: stored.sender?.userId ? "user" : stored.sender?.agentId ? "agent" : "system",
      name: browserSenderName(
        stored.sender ? { user: stored.sender.user, agent: stored.sender.agent } : null,
      ),
    },
    ...(stored.sender?.userId ? { senderUserId: stored.sender.userId } : {}),
    ...(stored.sender?.agentId ? { senderAgentId: stored.sender.agentId } : {}),
    ...(stored.threadRootId ? { threadRootId: stored.threadRootId } : {}),
  };
  const userIds = await activityRecipients(db, {
    ...message,
    threadRootId: stored.threadRootId ?? undefined,
  });
  if (userIds.length === 0) return;
  await realtime.conversationActivity({ userIds, event });
}
