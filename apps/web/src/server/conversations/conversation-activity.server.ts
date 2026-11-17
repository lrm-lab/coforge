import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import { BROWSER_MESSAGE_MENTIONS_SELECT, browserMessageMention } from "./mentions.server";
import { previewNoticeOf } from "#src/features/conversations/preview-line";
import { ACTION_CARD_PREVIEW_SELECT, previewCardFieldOf } from "./action-card-preview.server";
import { messagePreviewLine } from "./message-preview-line.server";
import { browserSenderName } from "./sender-display.server";
import {
  channelThreadUnreadsForMembers,
  isLegacyTaskThreadRoot,
  type ChannelThreadUnreadSummary,
} from "./channel-thread-unread.server";
import {
  announceBestEffort,
  type ConversationRealtime,
  type ConversationRealtimeMessage,
} from "./conversation-realtime.server";

/**
 * The recipients of one message's `conversation.activity.v1`: the people who may read it and whose
 * sidebar or Activity dot it may move. A channel's active human members; for a channel's thread
 * reply, the thread's human followers instead (it never changes a row, and only a follower's
 * Activity lists the thread); for a direct conversation, the people its signal scope names (both
 * people, or the person in a DM with an Agent), thread replies included, since its row counts them and every thread in it is theirs
 * (`ROW_MESSAGES_SQL`, task #734).
 *
 * The viewer's own message is in the list: their other tabs and devices must move the row too, and
 * the page is what ignores it for the badge.
 */
type ActivityRecipient = { userId: string; memberId?: string };

async function activityRecipients(
  db: PrismaClient,
  message: ConversationRealtimeMessage,
): Promise<ActivityRecipient[]> {
  if (message.directUserIds)
    return [...new Set(message.directUserIds)].map((userId) => ({ userId }));
  if (message.userId) return [{ userId: message.userId }];
  if (message.threadRootId) {
    const followers = await db.threadFollow.findMany({
      where: {
        rootMessageId: message.threadRootId,
        conversationId: message.conversationId,
        unfollowedAt: null,
      },
      select: { memberId: true, member: { select: { userId: true } } },
    });
    const byUser = new Map<string, ActivityRecipient>();
    for (const row of followers) {
      if (row.member.userId && !byUser.has(row.member.userId)) {
        byUser.set(row.member.userId, { userId: row.member.userId, memberId: row.memberId });
      }
    }
    return [...byUser.values()];
  }
  const members = await db.conversationMember.findMany({
    where: { conversationId: message.conversationId, leftAt: null, userId: { not: null } },
    select: { id: true, userId: true },
  });
  const byUser = new Map<string, ActivityRecipient>();
  for (const row of members) {
    if (row.userId && !byUser.has(row.userId)) {
      byUser.set(row.userId, { userId: row.userId, memberId: row.id });
    }
  }
  return [...byUser.values()];
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
      conversation: { select: { channelName: true, kind: true } },
      sender: {
        select: {
          userId: true,
          agentId: true,
          user: { select: { displayName: true, username: true } },
          agent: { select: { name: true, displayName: true } },
        },
      },
      mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
      // A note-less forward previews as its first original.
      forwards: { select: { sourceBody: true }, orderBy: { position: "asc" }, take: 1 },
      systemMessage: { select: { kind: true, params: true } },
      actionCard: ACTION_CARD_PREVIEW_SELECT,
    },
  });
  if (!stored) {
    unannounced("message_not_found", message);
    return;
  }
  // A task's own conversation is hidden: no sidebar row or count to move. Its readers hear of it
  // through their Activity (`task-publication.server.ts`).
  if (stored.conversation.kind === "task_thread") return;
  const event: ConversationActivityEvent = {
    type: REALTIME_EVENTS.conversationActivity,
    workspaceId: stored.workspaceId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    sequence: message.sequence,
    kind: stored.conversation.channelName === null ? "direct" : "channel",
    createdAt: stored.createdAt.toISOString(),
    preview: messagePreviewLine(
      stored.body,
      stored.mentions.map((mention) => browserMessageMention(mention)),
      stored.forwards[0]?.sourceBody,
    ),
    ...previewNoticeOf(stored.systemMessage?.kind ?? null, stored.systemMessage?.params),
    ...previewCardFieldOf(stored.actionCard),
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
  const recipients = await activityRecipients(db, {
    ...message,
    threadRootId: stored.threadRootId ?? undefined,
  });
  if (recipients.length === 0) return;
  const userIds = recipients.map((recipient) => recipient.userId);
  const mentionedUserIds = new Set(
    stored.mentions.flatMap((mention) => (mention.kind === "user" ? [mention.actorId] : [])),
  );
  const senderUserId = stored.sender?.userId;
  const muted = stored.threadRootId
    ? new Set<string>()
    : new Set(
        (
          await db.conversationMember.findMany({
            where: {
              conversationId: message.conversationId,
              userId: { in: userIds },
              notificationLevel: "muted",
            },
            select: { userId: true },
          })
        ).flatMap((member) => (member.userId ? [member.userId] : [])),
      );
  let threadUnreadsByMember: Map<string, ChannelThreadUnreadSummary> | undefined;
  if (
    stored.threadRootId &&
    event.kind === "channel" &&
    !(await isLegacyTaskThreadRoot(db, message.conversationId, stored.threadRootId))
  ) {
    const followerMemberIds = recipients.flatMap((r) => (r.memberId ? [r.memberId] : []));
    threadUnreadsByMember = await channelThreadUnreadsForMembers(
      db,
      message.conversationId,
      followerMemberIds,
    );
  }
  const buckets = new Map<string, { userIds: string[]; event: ConversationActivityEvent }>();
  for (const recipient of recipients) {
    const isMuted = muted.has(recipient.userId);
    const isMentioned =
      event.kind === "channel" &&
      mentionedUserIds.has(recipient.userId) &&
      recipient.userId !== senderUserId;
    const threadSummary =
      recipient.memberId && threadUnreadsByMember
        ? threadUnreadsByMember.get(recipient.memberId)
        : undefined;
    const bucketKey = `${isMuted ? 1 : 0}:${isMentioned ? 1 : 0}:${threadSummary ? threadSummary.unreadThreadCount : ""}:${threadSummary?.threadMentioned ? 1 : 0}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.userIds.push(recipient.userId);
      continue;
    }
    buckets.set(bucketKey, {
      userIds: [recipient.userId],
      event: {
        ...event,
        ...(isMuted ? { muted: true as const } : {}),
        ...(isMentioned ? { mentioned: true as const } : {}),
        ...(threadSummary ? { unreadThreadCount: threadSummary.unreadThreadCount } : {}),
        ...(threadSummary?.threadMentioned ? { threadMentioned: true as const } : {}),
      },
    });
  }
  for (const bucket of buckets.values()) {
    await realtime.conversationActivity(bucket);
  }
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
