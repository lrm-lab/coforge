import type { PrismaClient } from "#src/generated/prisma/client";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import { BROWSER_MESSAGE_MENTIONS_SELECT, browserMessageMention } from "./mentions.server";
import { messagePreviewLine } from "./message-preview-line.server";
import { browserSenderName } from "./sender-display.server";
import {
  announceBestEffort,
  type ConversationRealtime,
  type ConversationRealtimeMessage,
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
 * recipients. Both are required: an announcement that cannot reach the recipients' own channels
 * leaves every other page's sidebar, unread counts and Activity dot behind (task #348: every Agent's
 * message went out without them, its repository passing no database). A write path announces
 * through `announceMessageBestEffort`, which logs a failure instead of failing the write.
 */
export async function announceMessage(
  db: PrismaClient,
  realtime: Pick<ConversationRealtime, "messageAvailable" | "conversationActivity">,
  message: ConversationRealtimeMessage,
): Promise<void> {
  await realtime.messageAvailable(message);
  if (!realtime.conversationActivity) {
    unannounced("port_without_activity", message);
    return;
  }
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
      forward: { select: { sourceBody: true } },
    },
  });
  if (!stored) {
    unannounced("message_not_found", message);
    return;
  }
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
      stored.forward?.sourceBody,
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

function unannounced(reason: string, message: ConversationRealtimeMessage) {
  console.warn(
    JSON.stringify({
      event: "conversation_realtime:activity_unannounced",
      reason,
      conversation_id: message.conversationId,
      message_id: message.messageId,
    }),
  );
}

/**
 * `announceMessage` once a write has committed, through `announceBestEffort`: a write path with no
 * port of its own announces through the production one, and a failed publish is logged as
 * `conversation_realtime:message_failed` instead of failing the write. PostgreSQL stays canonical,
 * and a page that missed the announcement reads again when it next subscribes.
 */
export function announceMessageBestEffort(
  db: PrismaClient,
  realtime: Pick<ConversationRealtime, "messageAvailable" | "conversationActivity"> | undefined,
  message: ConversationRealtimeMessage,
): Promise<void> {
  return announceBestEffort(realtime, (port) => announceMessage(db, port, message), {
    name: "message",
    workspace_id: message.workspaceId ?? "",
    conversation_id: message.conversationId,
    message_id: message.messageId,
  });
}
