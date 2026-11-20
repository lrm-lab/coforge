import { recordChannelThreadUnread } from "./channel-thread-unread-events.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { announceReadMoved } from "#src/server/inbox/activity-attention.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { memberChannel, type PublicChannelPorts } from "./channel-access.server";
import { lockConversation } from "./conversation-lock.server";
import { announceConversationReadChanged } from "./conversation-read-realtime.server";
import type { ConversationRealtime } from "./conversation-realtime.server";

export async function markChannelAndThreadsRead(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  const moved = await db.$transaction(async (tx) => {
    await lockConversation(tx, channel.id);
    const member = await tx.conversationMember.findFirst({
      where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true, readThroughSequence: true, unreadFromSequence: true },
    });
    if (!member) return undefined;
    const latestTop = await tx.message.findFirst({
      where: { conversationId: channel.id, threadRootId: null },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const nextReadThrough = Math.max(member.readThroughSequence, latestTop?.sequence ?? 0);
    const readThroughAdvanced = nextReadThrough > member.readThroughSequence;
    const markerCleared = member.unreadFromSequence !== null;
    if (readThroughAdvanced || markerCleared) {
      await tx.conversationMember.updateMany({
        where: { id: member.id, ...ACTIVE_MEMBER_WHERE },
        data: { readThroughSequence: nextReadThrough, unreadFromSequence: null },
      });
    }
    const threadsAdvanced = await tx.$executeRaw`
      INSERT INTO "thread_reads"
        ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
      SELECT tf."memberId", tf."conversationId", ${workspaceId}::uuid,
        tf."rootMessageId", latest."sequence"
      FROM "thread_follows" tf
      CROSS JOIN LATERAL (
        SELECT m."sequence" FROM "messages" m
        WHERE m."conversationId" = tf."conversationId"
          AND m."threadRootId" = tf."rootMessageId"
        ORDER BY m."sequence" DESC LIMIT 1
      ) latest
      WHERE tf."memberId" = ${member.id}::uuid
        AND tf."conversationId" = ${channel.id}::uuid
        AND tf."unfollowedAt" IS NULL
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
        "readThroughSequence" = EXCLUDED."readThroughSequence"
      WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"`;
    if (threadsAdvanced > 0)
      await recordChannelThreadUnread(tx, { workspaceId, conversationId: channel.id, userId });
    if (!readThroughAdvanced && !markerCleared && threadsAdvanced === 0) return undefined;
    return { memberId: member.id, readThroughAdvanced, nextReadThrough };
  });
  if (!moved) return;
  await Promise.all([
    announceReadMoved(db, realtime, workspaceId, userId, [
      { conversationId: channel.id, channel: true },
    ]),
    ...(moved.readThroughAdvanced
      ? [
          announceConversationReadChanged(realtime, {
            workspaceId,
            conversationId: channel.id,
            memberId: moved.memberId,
            readThroughSequence: moved.nextReadThrough,
          }),
        ]
      : []),
  ]);
}

export async function markDirectAndThreadsRead(
  db: PrismaClient,
  realtime:
    | Pick<
        ConversationRealtime,
        "viewerChanged" | "viewerEventsChanged" | "conversationReadChanged" | "activityChanged"
      >
    | undefined,
  workspaceId: string,
  userId: string,
  conversationId: string,
) {
  const moved = await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const member = await tx.conversationMember.findFirst({
      where: { conversationId, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true, readThroughSequence: true, unreadFromSequence: true },
    });
    if (!member) return undefined;
    const latest = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const nextReadThrough = Math.max(member.readThroughSequence, latest?.sequence ?? 0);
    const readThroughAdvanced = nextReadThrough > member.readThroughSequence;
    const markerCleared = member.unreadFromSequence !== null;
    if (readThroughAdvanced || markerCleared) {
      await tx.conversationMember.updateMany({
        where: { id: member.id, ...ACTIVE_MEMBER_WHERE },
        data: { readThroughSequence: nextReadThrough, unreadFromSequence: null },
      });
    }
    const threadsAdvanced = await tx.$executeRaw`
      INSERT INTO "thread_reads"
        ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
      SELECT ${member.id}::uuid, ${conversationId}::uuid, ${workspaceId}::uuid,
        roots."rootMessageId", latest_reply."sequence"
      FROM (
        SELECT DISTINCT r."threadRootId" AS "rootMessageId"
        FROM "messages" r
        WHERE r."conversationId" = ${conversationId}::uuid AND r."threadRootId" IS NOT NULL
      ) roots
      CROSS JOIN LATERAL (
        SELECT m."sequence" FROM "messages" m
        WHERE m."conversationId" = ${conversationId}::uuid
          AND m."threadRootId" = roots."rootMessageId"
        ORDER BY m."sequence" DESC LIMIT 1
      ) latest_reply
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
        "readThroughSequence" = EXCLUDED."readThroughSequence"
      WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"`;
    if (!readThroughAdvanced && !markerCleared && threadsAdvanced === 0) return undefined;
    return { memberId: member.id, readThroughAdvanced, nextReadThrough };
  });
  if (!moved) return;
  await Promise.all([
    announceReadMoved(db, realtime, workspaceId, userId, [{ conversationId, channel: false }]),
    ...(moved.readThroughAdvanced
      ? [
          announceConversationReadChanged(realtime, {
            workspaceId,
            conversationId,
            memberId: moved.memberId,
            readThroughSequence: moved.nextReadThrough,
          }),
        ]
      : []),
  ]);
}
