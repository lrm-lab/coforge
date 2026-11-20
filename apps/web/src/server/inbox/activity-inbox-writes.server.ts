import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import type {
  ActivityArtifactMark,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import { doneArtifactsSql, readArtifactsSql } from "#src/server/artifacts/artifact-activity.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { recordChannelThreadUnread } from "#src/server/conversations/channel-thread-unread-events.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  directThreadsSql,
  followedChannelThreadsSql,
  markConversationDoneSql,
  markConversationsReadSql,
  markThreadDoneSql,
  markThreadsReadSql,
} from "#src/server/conversations/human-unread.server";
import { announceActivityAttention, announceReadMoved } from "./activity-attention.server";

export type ActivityInboxRealtime = Pick<
  ConversationRealtime,
  "viewerChanged" | "viewerEventsChanged" | "activityChanged"
>;

export async function markActivityDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  item: ActivityItemDone,
) {
  if (item.kind === "artifact") {
    await requireWorkspaceMember(db, workspaceId, userId);
    await db.$queryRaw(
      doneArtifactsSql(workspaceId, userId, {
        through: new Date(item.throughAt),
        artifactId: item.artifactId,
      }),
    );
    await announceActivityAttention(db, realtime, workspaceId, userId);
    return;
  }
  if (item.kind === "mention_action") {
    await requireWorkspaceMember(db, workspaceId, userId);
    await db.pendingMentionAction.updateMany({
      where: { id: item.resolutionId, workspaceId, targetUserId: userId, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
    await announceActivityAttention(db, realtime, workspaceId, userId);
    return;
  }
  const rootMessageId = item.kind === "thread" ? item.rootMessageId : null;
  const [, member, latest] = await Promise.all([
    requireWorkspaceMember(db, workspaceId, userId),
    db.conversationMember.findFirst({
      where: { conversationId: item.conversationId, workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
      select: {
        id: true,
        readThroughSequence: true,
        unreadFromSequence: true,
        conversation: { select: { channelName: true, kind: true } },
      },
    }),
    db.message.findFirst({
      where: { conversationId: item.conversationId, threadRootId: rootMessageId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    }),
  ]);
  if (!member) throw new AppError("ACCESS_DENIED");
  const boundary = Math.min(item.throughSequence, latest?.sequence ?? 0);
  if (boundary < 1) return;
  if (rootMessageId) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw(
        markThreadDoneSql(
          {
            memberId: member.id,
            conversationId: item.conversationId,
            workspaceId,
            rootMessageId,
          },
          boundary,
        ),
      );
      if (member.conversation.channelName !== null)
        await recordChannelThreadUnread(tx, {
          workspaceId,
          conversationId: item.conversationId,
          userId,
        });
    });
  } else {
    await db.$executeRaw(markConversationDoneSql(member.id, boundary));
  }
  const readMoved =
    member.readThroughSequence < boundary ||
    (member.unreadFromSequence !== null && member.unreadFromSequence <= boundary);
  const badgeMoved = !rootMessageId && readMoved && member.conversation.kind !== "task_thread";
  await announceReadMoved(
    db,
    realtime,
    workspaceId,
    userId,
    badgeMoved
      ? [{ conversationId: item.conversationId, channel: member.conversation.channelName !== null }]
      : [],
  );
}

export async function markActivityArtifactRead(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  item: ActivityArtifactMark,
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  await db.$queryRaw(
    readArtifactsSql(workspaceId, userId, {
      through: new Date(item.throughAt),
      artifactId: item.artifactId,
    }),
  );
  await announceActivityAttention(db, realtime, workspaceId, userId);
}

export async function markActivityAllRead(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  options: { before: Date },
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  const { before } = options;
  const moved = await db.$transaction(async (tx) => {
    const conversations = await tx.$queryRaw<
      { conversationId: string; channel: boolean; task: boolean }[]
    >(markConversationsReadSql(workspaceId, userId, before));
    await tx.pendingMentionAction.updateMany({
      where: {
        workspaceId,
        targetUserId: userId,
        notifiedAt: { not: null, lte: before },
        targetReadAt: null,
      },
      data: { targetReadAt: new Date() },
    });
    const threads = await tx.$queryRaw<{ conversationId: string }[]>(
      markThreadsReadSql(workspaceId, followedChannelThreadsSql(workspaceId, userId), before, {
        returnChannels: true,
      }),
    );
    await tx.$executeRaw(
      markThreadsReadSql(workspaceId, directThreadsSql(workspaceId, userId), before),
    );
    await tx.$queryRaw(readArtifactsSql(workspaceId, userId, { through: before }));
    await recordChannelThreadUnread(
      tx,
      ...threads.map(({ conversationId }) => ({ workspaceId, conversationId, userId })),
    );
    return conversations;
  });
  await announceReadMoved(
    db,
    realtime,
    workspaceId,
    userId,
    moved.filter((row) => !row.task),
  );
}
