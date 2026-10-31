import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import type { ActivityItemDone } from "#src/features/inbox/activity-inbox.schemas";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
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

/** What the Activity inbox's writes may announce: a moved read cursor, and where the inbox stands. */
export type ActivityInboxRealtime = Pick<ConversationRealtime, "viewerChanged" | "activityChanged">;

/**
 * The Activity inbox's two clearing writes: Done on one item, and read-all. Both read through the
 * boundary they set and tell the person's other pages what they left behind. They live here rather
 * than in the read model so `activity-inbox.server.ts` keeps to listing and authorization.
 */

/**
 * Marks one item Done through the newest message the viewer saw (`throughSequence`), and reads
 * it through the same message: a message that arrived after the viewer's render keeps the item
 * listed and unread. The boundary only moves forward and is clamped to the item's newest
 * message.
 */
export async function markActivityDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  item: ActivityItemDone,
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  if (item.kind === "mention_action") {
    await db.pendingMentionAction.updateMany({
      where: { id: item.resolutionId, workspaceId, targetUserId: userId, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
    await announceActivityAttention(db, realtime, workspaceId, userId);
    return;
  }
  const member = await db.conversationMember.findFirst({
    where: { conversationId: item.conversationId, workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
    select: {
      id: true,
      readThroughSequence: true,
      unreadFromSequence: true,
      conversation: { select: { channelName: true, kind: true } },
    },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  const rootMessageId = item.kind === "thread" ? item.rootMessageId : null;
  const latest = await db.message.findFirst({
    where: { conversationId: item.conversationId, threadRootId: rootMessageId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const boundary = Math.min(item.throughSequence, latest?.sequence ?? 0);
  if (boundary < 1) return;
  await db.$executeRaw(
    rootMessageId
      ? markThreadDoneSql(
          {
            memberId: member.id,
            conversationId: item.conversationId,
            workspaceId,
            rootMessageId,
          },
          boundary,
        )
      : markConversationDoneSql(member.id, boundary),
  );
  // A conversation's Done reads it too, so its badge moves when the read cursor or a mark-unread
  // marker moves (a thread's Done never touches the badge).
  const readMoved =
    member.readThroughSequence < boundary ||
    (member.unreadFromSequence !== null && member.unreadFromSequence <= boundary);
  // A task's own conversation is hidden: it has no badge to move.
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

/**
 * Reads every joined conversation and every thread the inbox lists, through the newest message
 * posted at or before `before` (the list's `loadedAt`), in one transaction. Items stay listed;
 * only Done removes them.
 */
export async function markActivityAllRead(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  options: { before: Date },
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  const { before } = options;
  const [moved] = await db.$transaction([
    db.$queryRaw<{ conversationId: string; channel: boolean; task: boolean }[]>(
      markConversationsReadSql(workspaceId, userId, before),
    ),
    db.pendingMentionAction.updateMany({
      where: {
        workspaceId,
        targetUserId: userId,
        notifiedAt: { not: null, lte: before },
        targetReadAt: null,
      },
      data: { targetReadAt: new Date() },
    }),
    db.$executeRaw(
      markThreadsReadSql(workspaceId, followedChannelThreadsSql(workspaceId, userId), before),
    ),
    db.$executeRaw(markThreadsReadSql(workspaceId, directThreadsSql(workspaceId, userId), before)),
  ]);
  await announceReadMoved(
    db,
    realtime,
    workspaceId,
    userId,
    moved.filter((row) => !row.task),
  );
}
