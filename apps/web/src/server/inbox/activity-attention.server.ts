import type { PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import {
  announceBestEffort,
  announceViewerEvents,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import { humanReadStates } from "#src/server/conversations/human-unread.server";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { artifactUnreadKeysSql } from "#src/server/artifacts/artifact-activity.server";
import { compareActivityOrder } from "./activity-inbox-order";
import { NAV_UNREAD_KEY_LIMIT, activityNavAttentionSql } from "./activity-inbox-page-sql.server";

export type ActivityNavAttention = {
  hasUnread: boolean;
  unreadCount?: number;
  unreadKeys?: string[];
};

export async function navHasUnread(
  db: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  userId: string,
): Promise<ActivityNavAttention> {
  const [conversations, artifacts] = await Promise.all([
    db.$queryRaw<{ key: string; latestAt: Date; latestSequence: number }[]>(
      activityNavAttentionSql(workspaceId, userId),
    ),
    db.$queryRaw<{ key: string; latestAt: Date }[]>(artifactUnreadKeysSql(workspaceId, userId)),
  ]);
  const unread = [...conversations, ...artifacts.map((row) => ({ ...row, latestSequence: 0 }))]
    .sort(compareActivityOrder)
    .slice(0, NAV_UNREAD_KEY_LIMIT);
  return {
    hasUnread: unread.length > 0,
    unreadCount: unread.length,
    unreadKeys: unread.map((row) => row.key),
  } satisfies ActivityNavAttention;
}

export async function announceActivityAttention(
  db: Pick<PrismaClient, "$queryRaw">,
  realtime: Pick<ConversationRealtime, "activityChanged"> | undefined,
  workspaceId: string,
  userId: string,
) {
  await announceBestEffort(
    realtime,
    async (port) => {
      if (!port.activityChanged) return;
      const channel = userConversationChannel(userId);
      const { streamPositions, data: attention } = await readAfterStreamPositions([channel], () =>
        navHasUnread(db, workspaceId, userId),
      );
      const streamPosition = streamPositions[channel];
      await port.activityChanged({
        workspaceId,
        userId,
        attention: { ...attention, ...(streamPosition && { streamPosition }) },
      });
    },
    { name: "activity_changed", workspace_id: workspaceId },
  );
}

export async function announceReadMoved(
  db: Pick<PrismaClient, "$queryRaw">,
  realtime:
    | Pick<ConversationRealtime, "viewerChanged" | "viewerEventsChanged" | "activityChanged">
    | undefined,
  workspaceId: string,
  userId: string,
  moved: readonly { conversationId: string; channel: boolean }[],
) {
  const announceMarked = async () => {
    if (moved.length === 0) return;
    const states = await humanReadStates(
      db,
      userId,
      moved.map((row) => row.conversationId),
    );
    await announceViewerEvents(realtime, {
      userIds: [userId],
      events: moved.map(({ conversationId, channel }) => ({
        type: channel ? ("channel.marked.v1" as const) : ("dm.marked.v1" as const),
        workspaceId,
        conversationId,
        ...(states.get(conversationId) ?? { unreadCount: 0, readThroughSequence: 0 }),
      })),
    });
  };
  await Promise.all([
    announceMarked(),
    announceActivityAttention(db, realtime, workspaceId, userId),
  ]);
}
