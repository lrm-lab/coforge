import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  centrifugoServerApiConfigured,
  createCentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { AppError } from "#src/lib/app-error";
import type { ThreadUnreadMark } from "#src/features/conversations/thread-unread-inputs";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { announceActivityAttention } from "#src/server/inbox/activity-attention.server";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { lockConversation } from "./conversation-lock.server";
import { advanceThreadRead } from "#src/server/db/repositories/thread-read-position.server";
import { recordChannelThreadUnread } from "./channel-thread-unread-events.server";
import {
  announceViewerEvents,
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import { viewerDirectConversationWhere } from "./viewer-direct-conversations.server";

export type ThreadUnreadScope = {
  workspaceId: string;
  conversationId: string;
  userId: string;
};

type ThreadUnreadRealtime = Pick<
  ConversationRealtime,
  "viewerChanged" | "viewerEventsChanged" | "activityChanged"
>;

export function threadUnreadRealtime() {
  return centrifugoServerApiConfigured()
    ? new CentrifugoConversationRealtime(createCentrifugoServerApi())
    : undefined;
}

function memberWhere({ workspaceId, conversationId, userId }: ThreadUnreadScope) {
  return {
    workspaceId,
    conversationId,
    userId,
    ...ACTIVE_MEMBER_WHERE,
    conversation: {
      ...VISIBLE_CONVERSATION_WHERE,
      archivedAt: null,
      workspace: { members: { some: { userId } } },
      OR: [{ channelName: { not: null } }, viewerDirectConversationWhere(userId)],
      AND: [{ OR: [{ kind: null }, { kind: { not: "task_thread" } }] }],
    },
  } satisfies Prisma.ConversationMemberWhereInput;
}

const ordinaryRootWhere = {
  threadRootId: null,
  OR: [{ task: null }, { task: { deletedAt: { not: null } } }],
} satisfies Prisma.MessageWhereInput;

export async function requireThreadUnreadMember(
  db: Prisma.TransactionClient,
  scope: ThreadUnreadScope,
) {
  const member = await db.conversationMember.findFirst({
    where: memberWhere(scope),
    select: { id: true, conversation: { select: { channelName: true } } },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  return { id: member.id, channel: member.conversation.channelName !== null };
}

async function requireOrdinaryRoot(
  db: Prisma.TransactionClient,
  conversationId: string,
  rootMessageId: string,
) {
  const root = await db.message.findFirst({
    where: { ...ordinaryRootWhere, conversationId, id: rootMessageId },
    select: { id: true },
  });
  if (!root) throw new AppError("NOT_FOUND");
}

export async function markThreadUnread(
  db: PrismaClient,
  realtime: ThreadUnreadRealtime | undefined,
  scope: ThreadUnreadScope,
  rootMessageId: string,
): Promise<ThreadUnreadMark> {
  const { workspaceId, conversationId } = scope;
  const version = crypto.randomUUID();
  await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const member = await requireThreadUnreadMember(tx, scope);
    await requireOrdinaryRoot(tx, conversationId, rootMessageId);
    await tx.$executeRaw`INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "markedUnreadVersion")
      VALUES (${member.id}::uuid, ${conversationId}::uuid, ${workspaceId}::uuid,
        ${rootMessageId}::uuid, ${version}::uuid)
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE
      SET "markedUnreadVersion" = EXCLUDED."markedUnreadVersion"`;
    if (member.channel) await recordChannelThreadUnread(tx, scope);
  });
  const mark = { rootMessageId, version };
  await announceThreadUnreadChanges(db, realtime, scope, "marked", [mark]);
  return mark;
}

export async function readThreadUnreadVersion(
  db: PrismaClient,
  scope: ThreadUnreadScope,
  rootMessageId: string,
) {
  const mark = await db.threadRead.findFirst({
    where: {
      conversationId: scope.conversationId,
      rootMessageId,
      markedUnreadVersion: { not: null },
      member: memberWhere(scope),
      root: ordinaryRootWhere,
    },
    select: { markedUnreadVersion: true },
  });
  return mark?.markedUnreadVersion ?? undefined;
}

export async function loadThreadUnreadSnapshot(db: PrismaClient, scope: ThreadUnreadScope) {
  return db.$transaction(
    async (tx) => {
      const member = await requireThreadUnreadMember(tx, scope);
      const [latest, rows] = await Promise.all([
        tx.message.findFirst({
          where: { conversationId: scope.conversationId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        }),
        tx.threadRead.findMany({
          where: {
            memberId: member.id,
            conversationId: scope.conversationId,
            markedUnreadVersion: { not: null },
            root: ordinaryRootWhere,
          },
          select: { rootMessageId: true, markedUnreadVersion: true },
          orderBy: { rootMessageId: "asc" },
        }),
      ]);
      return {
        throughSequence: latest?.sequence ?? 0,
        marks: rows.flatMap(({ rootMessageId, markedUnreadVersion }) =>
          markedUnreadVersion ? [{ rootMessageId, version: markedUnreadVersion }] : [],
        ),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function clearThreadUnreadMarks(
  tx: Prisma.TransactionClient,
  scope: ThreadUnreadScope,
  memberId: string,
  marks: readonly ThreadUnreadMark[],
  throughSequence?: number,
) {
  if (marks.length === 0) return [];
  const cleared = await tx.threadRead.updateManyAndReturn({
    where: {
      memberId,
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      member: memberWhere(scope),
      root: {
        ...ordinaryRootWhere,
        ...(throughSequence !== undefined && { sequence: { lte: throughSequence } }),
      },
      OR: marks.map(({ rootMessageId, version }) => ({
        rootMessageId,
        markedUnreadVersion: version,
      })),
    },
    data: { markedUnreadVersion: null },
    select: { rootMessageId: true },
  });
  const clearedRoots = new Set(cleared.map(({ rootMessageId }) => rootMessageId));
  return marks.filter(({ rootMessageId }) => clearedRoots.delete(rootMessageId));
}

export async function markVersionedThreadRead(
  db: PrismaClient,
  realtime: ThreadUnreadRealtime | undefined,
  scope: ThreadUnreadScope,
  mark: ThreadUnreadMark,
  throughSequence: number,
) {
  const { workspaceId, conversationId, userId } = scope;
  const { cleared, advanced } = await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const member = await requireThreadUnreadMember(tx, scope);
    await requireOrdinaryRoot(tx, conversationId, mark.rootMessageId);
    const latest = await tx.message.findFirst({
      where: {
        conversationId,
        threadRootId: mark.rootMessageId,
        sequence: { lte: throughSequence },
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const advanced = latest
      ? await advanceThreadRead(
          tx,
          member.id,
          conversationId,
          workspaceId,
          mark.rootMessageId,
          latest.sequence,
        )
      : false;
    const cleared = await clearThreadUnreadMarks(tx, scope, member.id, [mark], throughSequence);
    if (member.channel && (advanced || cleared.length > 0))
      await recordChannelThreadUnread(tx, scope);
    return { advanced, cleared };
  });
  if (cleared.length > 0)
    await announceThreadUnreadChanges(db, realtime, scope, "cleared", cleared);
  else if (advanced) await announceActivityAttention(db, realtime, workspaceId, userId);
}

export async function publishThreadUnreadChanges(
  realtime: ThreadUnreadRealtime | undefined,
  { workspaceId, conversationId, userId }: ThreadUnreadScope,
  action: "marked" | "cleared",
  marks: readonly ThreadUnreadMark[],
) {
  if (marks.length === 0) return;
  await announceViewerEvents(realtime, {
    userIds: [userId],
    events: marks.map((mark) => ({
      ...mark,
      type: REALTIME_EVENTS.threadUnreadChanged,
      workspaceId,
      conversationId,
      action,
    })),
  });
}

async function announceThreadUnreadChanges(
  db: PrismaClient,
  realtime: ThreadUnreadRealtime | undefined,
  scope: ThreadUnreadScope,
  action: "marked" | "cleared",
  marks: readonly ThreadUnreadMark[],
) {
  await Promise.all([
    publishThreadUnreadChanges(realtime, scope, action, marks),
    announceActivityAttention(db, realtime, scope.workspaceId, scope.userId),
  ]);
}
