import type { PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import {
  announceBestEffort,
  announceViewerEvent,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import { humanReadStates } from "#src/server/conversations/human-unread.server";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { navHasUnreadSql } from "./activity-inbox-items-sql.server";
import { taskHasUnreadSql } from "./activity-inbox-task-items.server";

/** Whether the person has any unread activity: all the nav rail's Activity dot shows
 * (`navHasUnreadSql` says what it reads). The caller has checked they belong to the Workspace. */
export async function navHasUnread(
  db: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  userId: string,
) {
  const [{ hasUnread }] = await db.$queryRaw<[{ hasUnread: boolean }]>(
    navHasUnreadSql(workspaceId, userId, taskHasUnreadSql(workspaceId, userId)),
  );
  return hasUnread;
}

/**
 * Tells the person's other pages, after a write of theirs that can clear their Activity, where it
 * now stands (`ActivityAttention`), so each nav dot takes the answer instead of every open page
 * reading it again. The stream position is read first, as for a list (`readAfterStreamPositions`).
 * Best effort once the write has committed, like every announcement (`announceBestEffort`).
 */
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
      const { streamPositions, data: hasUnread } = await readAfterStreamPositions([channel], () =>
        navHasUnread(db, workspaceId, userId),
      );
      const streamPosition = streamPositions[channel];
      await port.activityChanged({
        workspaceId,
        userId,
        attention: { hasUnread, ...(streamPosition && { streamPosition }) },
      });
    },
    { name: "activity_changed", workspace_id: workspaceId },
  );
}

/**
 * After a write of the person's that moved their read place in some conversations (a Done, a
 * read-all, a conversation marked unread or read), tells their other pages, together: the badge
 * each moved conversation is left with (Slack's `channel_marked` / `im_marked`), as a read inside
 * the conversation does, and where their Activity now stands (`announceActivityAttention`).
 */
export async function announceReadMoved(
  db: Pick<PrismaClient, "$queryRaw">,
  realtime: Pick<ConversationRealtime, "viewerChanged" | "activityChanged"> | undefined,
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
    await Promise.all(
      moved.map(({ conversationId, channel }) =>
        announceViewerEvent(realtime, {
          userIds: [userId],
          event: {
            type: channel ? "channel.marked.v1" : "dm.marked.v1",
            workspaceId,
            conversationId,
            ...(states.get(conversationId) ?? { unreadCount: 0, readThroughSequence: 0 }),
          },
        }),
      ),
    );
  };
  await Promise.all([
    announceMarked(),
    announceActivityAttention(db, realtime, workspaceId, userId),
  ]);
}
