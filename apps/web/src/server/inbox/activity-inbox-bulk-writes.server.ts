import { recordChannelThreadUnread } from "#src/server/conversations/channel-thread-unread-events.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import type { ActivityDoneUndo } from "#src/features/inbox/activity-inbox.schemas";
import {
  doneArtifactsSql,
  restoreArtifactsDoneSql,
  type ArtifactDoneRow,
} from "#src/server/artifacts/artifact-activity.server";
import { announceActivityAttention, announceReadMoved } from "./activity-attention.server";
import type { ActivityInboxRealtime } from "./activity-inbox-writes.server";
import {
  allConversationsTargetSql,
  allThreadsTargetSql,
  conversationsDoneSql,
  restoreConversationsDoneSql,
  restoreThreadsDoneSql,
  threadsDoneSql,
  type ConversationDoneRow,
  type ThreadDoneRow,
} from "./activity-inbox-bulk-sql.server";

const UNDO_ROW_LIMIT = 5_000;

export type ActivityBulkDone = {
  count: number;
  undo: ActivityDoneUndo | null;
};

function undoOf(
  conversations: ConversationDoneRow[],
  threads: ThreadDoneRow[],
  mentions: { ids: string[]; at: Date },
  artifacts: ArtifactDoneRow[],
): ActivityDoneUndo | null {
  const moved = <Row extends { previous: number | null; through: number }>(row: Row) =>
    row.previous === null || row.previous < row.through;
  const members = conversations
    .filter(moved)
    .map(({ memberId, previous, through }) => ({ memberId, previous, through }));
  const threadRows = threads
    .filter(moved)
    .map(({ memberId, rootMessageId, previous, through }) => ({
      memberId,
      rootMessageId,
      previous,
      through,
    }));
  const artifactRows = artifacts.map((row) => ({
    artifactId: row.artifactId,
    previousReadAt: row.previousReadAt?.getTime() ?? null,
    previousDoneAt: row.previousDoneAt?.getTime() ?? null,
    through: row.through.getTime(),
  }));
  const rows = members.length + threadRows.length + mentions.ids.length + artifactRows.length;
  if (rows === 0 || rows > UNDO_ROW_LIMIT) return null;
  return {
    members,
    threads: threadRows,
    mentions: { ids: mentions.ids, at: mentions.at.getTime() },
    artifacts: artifactRows,
  };
}

function dismissMentions(
  db: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  userId: string,
  before: Date,
  at: Date,
) {
  return db.$queryRaw<{ id: string }[]>`
    UPDATE "pending_mention_actions" SET "dismissedAt" = ${at}
    WHERE "workspaceId" = ${workspaceId}::uuid AND "targetUserId" = ${userId}::uuid
      AND "notifiedAt" IS NOT NULL AND "notifiedAt" <= ${before}
      AND "dismissedAt" IS NULL
    RETURNING "id"`;
}

async function announceDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  conversations: ConversationDoneRow[],
) {
  await announceReadMoved(
    db,
    realtime,
    workspaceId,
    userId,
    conversations.filter((row) => row.readMoved && !row.task),
  );
}

export async function markActivityAllDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  options: { before: Date },
): Promise<ActivityBulkDone> {
  await requireWorkspaceMember(db, workspaceId, userId);
  const { before } = options;
  const at = new Date();
  const { conversations, threads, mentions, artifacts } = await db.$transaction(async (tx) => {
    const conversations = await tx.$queryRaw<ConversationDoneRow[]>(
      conversationsDoneSql(allConversationsTargetSql(workspaceId, userId, before)),
    );
    const threads = await tx.$queryRaw<ThreadDoneRow[]>(
      threadsDoneSql(workspaceId, allThreadsTargetSql(workspaceId, userId, before)),
    );
    const mentions = await dismissMentions(tx, workspaceId, userId, before, at);
    const artifacts = await tx.$queryRaw<ArtifactDoneRow[]>(
      doneArtifactsSql(workspaceId, userId, { through: before }),
    );
    const channels = new Set(threads.filter((row) => row.channel).map((row) => row.conversationId));
    await recordChannelThreadUnread(
      tx,
      ...[...channels].map((conversationId) => ({ workspaceId, conversationId, userId })),
    );
    return { conversations, threads, mentions, artifacts };
  });
  await announceDone(db, realtime, workspaceId, userId, conversations);
  const ids = mentions.map((row) => row.id);
  return {
    count: conversations.length + threads.length + ids.length + artifacts.length,
    undo: undoOf(conversations, threads, { ids, at }, artifacts),
  };
}

export async function undoActivityDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  undo: ActivityDoneUndo,
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  await db.$transaction([
    db.$executeRaw(restoreConversationsDoneSql(workspaceId, userId, undo.members)),
    db.$executeRaw(restoreThreadsDoneSql(workspaceId, userId, undo.threads)),
    db.pendingMentionAction.updateMany({
      where: {
        id: { in: undo.mentions.ids },
        workspaceId,
        targetUserId: userId,
        dismissedAt: new Date(undo.mentions.at),
      },
      data: { dismissedAt: null },
    }),
    ...(undo.artifacts.length > 0
      ? [db.$executeRaw(restoreArtifactsDoneSql(userId, undo.artifacts))]
      : []),
  ]);
  await announceActivityAttention(db, realtime, workspaceId, userId);
}
