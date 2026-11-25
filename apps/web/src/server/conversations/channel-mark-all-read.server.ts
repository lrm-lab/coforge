import { MAX_MESSAGE_SEQUENCE } from "@lrm/coforge-sdk/internal";
import type { ThreadUnreadBatch } from "#src/features/conversations/thread-unread-inputs";
import {
  clearThreadUnreadMarks,
  publishThreadUnreadChanges,
  requireThreadUnreadMember,
} from "./thread-unread-marks.server";
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
  batch?: ThreadUnreadBatch,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  const scope = { workspaceId, conversationId: channel.id, userId };
  const moved = await db.$transaction(async (tx) => {
    await lockConversation(tx, channel.id);
    if (batch) await requireThreadUnreadMember(tx, scope);
    const member = await tx.conversationMember.findFirst({
      where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true, readThroughSequence: true, unreadFromSequence: true },
    });
    if (!member) return undefined;
    const latestTop = await tx.message.findFirst({
      where: {
        conversationId: channel.id,
        threadRootId: null,
        sequence: { lte: batch?.throughSequence ?? MAX_MESSAGE_SEQUENCE },
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const nextReadThrough = Math.max(member.readThroughSequence, latestTop?.sequence ?? 0);
    const readThroughAdvanced = nextReadThrough > member.readThroughSequence;
    const markerCleared =
      member.unreadFromSequence !== null &&
      (!batch || member.unreadFromSequence <= batch.throughSequence);
    if (readThroughAdvanced || markerCleared) {
      await tx.conversationMember.updateMany({
        where: { id: member.id, ...ACTIVE_MEMBER_WHERE },
        data: {
          readThroughSequence: nextReadThrough,
          ...(markerCleared && { unreadFromSequence: null }),
        },
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
          AND m."sequence" <= ${batch?.throughSequence ?? MAX_MESSAGE_SEQUENCE}
        ORDER BY m."sequence" DESC LIMIT 1
      ) latest
      WHERE tf."memberId" = ${member.id}::uuid
        AND tf."conversationId" = ${channel.id}::uuid
        AND tf."unfollowedAt" IS NULL
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
        "readThroughSequence" = EXCLUDED."readThroughSequence"
      WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"`;
    const cleared = batch
      ? await clearThreadUnreadMarks(tx, scope, member.id, batch.marks, batch.throughSequence)
      : [];
    if (threadsAdvanced > 0 || cleared.length > 0) await recordChannelThreadUnread(tx, scope);
    if (!readThroughAdvanced && !markerCleared && threadsAdvanced === 0 && cleared.length === 0)
      return undefined;
    return { memberId: member.id, readThroughAdvanced, nextReadThrough, cleared };
  });
  if (!moved) return;
  await Promise.all([
    publishThreadUnreadChanges(realtime, scope, "cleared", moved.cleared),
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
  batch?: ThreadUnreadBatch,
) {
  const scope = { workspaceId, conversationId, userId };
  const moved = await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    if (batch) await requireThreadUnreadMember(tx, scope);
    const member = await tx.conversationMember.findFirst({
      where: { conversationId, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true, readThroughSequence: true, unreadFromSequence: true },
    });
    if (!member) return undefined;
    const latest = await tx.message.findFirst({
      where: { conversationId, sequence: { lte: batch?.throughSequence ?? MAX_MESSAGE_SEQUENCE } },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const nextReadThrough = Math.max(member.readThroughSequence, latest?.sequence ?? 0);
    const readThroughAdvanced = nextReadThrough > member.readThroughSequence;
    const markerCleared =
      member.unreadFromSequence !== null &&
      (!batch || member.unreadFromSequence <= batch.throughSequence);
    if (readThroughAdvanced || markerCleared) {
      await tx.conversationMember.updateMany({
        where: { id: member.id, ...ACTIVE_MEMBER_WHERE },
        data: {
          readThroughSequence: nextReadThrough,
          ...(markerCleared && { unreadFromSequence: null }),
        },
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
          AND m."sequence" <= ${batch?.throughSequence ?? MAX_MESSAGE_SEQUENCE}
        ORDER BY m."sequence" DESC LIMIT 1
      ) latest_reply
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
        "readThroughSequence" = EXCLUDED."readThroughSequence"
      WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"`;
    const cleared = batch
      ? await clearThreadUnreadMarks(tx, scope, member.id, batch.marks, batch.throughSequence)
      : [];
    if (!readThroughAdvanced && !markerCleared && threadsAdvanced === 0 && cleared.length === 0)
      return undefined;
    return { memberId: member.id, readThroughAdvanced, nextReadThrough, cleared };
  });
  if (!moved) return;
  await Promise.all([
    publishThreadUnreadChanges(realtime, scope, "cleared", moved.cleared),
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
