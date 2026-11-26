import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import { noticeExternalInbox } from "#src/server/agents/external-inbox-landing.server";
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

type ActivityRecipient = { userId: string; memberId?: string; muted?: boolean };

export type AnnounceMessageSnapshot = {
  body: string;
  createdAt: Date;
  threadRootId: string | null;
  workspaceId: string;
  conversation: { channelName: string | null; kind?: string | null };
  sender: {
    userId: string | null;
    agentId: string | null;
    user: { displayName: string | null; username: string } | null;
    agent: { name: string; displayName: string | null } | null;
  } | null;
  mentions: readonly Parameters<typeof browserMessageMention>[0][];
  forwards: readonly { sourceBody: string }[];
  systemMessage?: { kind: string; params: Prisma.JsonValue } | null;
  actionCard?: Parameters<typeof previewCardFieldOf>[0];
};

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
    select: { id: true, userId: true, notificationLevel: true },
  });
  const byUser = new Map<string, ActivityRecipient>();
  for (const row of members) {
    if (row.userId && !byUser.has(row.userId)) {
      byUser.set(row.userId, {
        userId: row.userId,
        memberId: row.id,
        muted: row.notificationLevel === "muted",
      });
    }
  }
  return [...byUser.values()];
}

export async function announceMessage(
  db: PrismaClient,
  realtime: Pick<ConversationRealtime, "messageAvailable" | "conversationActivity">,
  message: ConversationRealtimeMessage,
  snapshot?: AnnounceMessageSnapshot,
): Promise<void> {
  const available = realtime.messageAvailable(message);
  const conversationActivity = realtime.conversationActivity?.bind(realtime);
  if (!conversationActivity) {
    await available;
    void noticeExternalInbox(db, message);
    unannounced("port_without_activity", message);
    return;
  }
  const activityWork = (async () => {
    const stored: AnnounceMessageSnapshot | null =
      snapshot ??
      (await db.message.findUnique({
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
          forwards: { select: { sourceBody: true }, orderBy: { position: "asc" }, take: 1 },
          systemMessage: { select: { kind: true, params: true } },
          actionCard: ACTION_CARD_PREVIEW_SELECT,
        },
      }));
    void noticeExternalInbox(db, message);
    if (!stored) {
      unannounced("message_not_found", message);
      return;
    }
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
      ...previewCardFieldOf(stored.actionCard ?? null),
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
    const mentionedUserIds = new Set(
      stored.mentions.flatMap((mention) => (mention.kind === "user" ? [mention.actorId] : [])),
    );
    const senderUserId = stored.sender?.userId;
    const muted = new Set<string>();
    if (!stored.threadRootId) {
      const unknownMutedUserIds: string[] = [];
      for (const recipient of recipients) {
        if (recipient.muted === true) muted.add(recipient.userId);
        else if (recipient.muted === undefined) unknownMutedUserIds.push(recipient.userId);
      }
      if (unknownMutedUserIds.length > 0) {
        const mutedMembers = await db.conversationMember.findMany({
          where: {
            conversationId: message.conversationId,
            userId: { in: unknownMutedUserIds },
            notificationLevel: "muted",
          },
          select: { userId: true },
        });
        for (const member of mutedMembers) {
          if (member.userId) muted.add(member.userId);
        }
      }
    }
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
    await Promise.all([...buckets.values()].map((bucket) => conversationActivity(bucket)));
  })();
  await Promise.all([available, activityWork]);
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

export function announceMessageBestEffort(
  db: PrismaClient,
  realtime: Pick<ConversationRealtime, "messageAvailable" | "conversationActivity"> | undefined,
  message: ConversationRealtimeMessage,
  snapshot?: AnnounceMessageSnapshot,
): Promise<void> {
  return announceBestEffort(realtime, (port) => announceMessage(db, port, message, snapshot), {
    name: "message",
    workspace_id: message.workspaceId ?? "",
    conversation_id: message.conversationId,
    message_id: message.messageId,
  });
}
