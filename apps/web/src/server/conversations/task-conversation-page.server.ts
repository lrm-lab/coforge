import { conversationUnreadMessageSql, firstUnreadMessageIdSql } from "./human-unread.server";
import { LIVE_TASK_WHERE, taskMentions } from "#src/server/tasks/task-view.server";
import {
  taskEventsInWindow,
  messageTime,
  messageTimeUpTo,
} from "#src/server/tasks/task-timeline.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { windowPageFlags } from "#src/lib/conversation-window";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { HistoryWindow } from "#src/server/db/repositories/direct-conversation-types.server";
import { conversationMentionables } from "#src/server/db/repositories/user-direct-reads.repositories.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT } from "./mentions.server";
import { ConversationHistory } from "./conversation-history.server";
import { browserMessageFields, mapBrowserMessages } from "./browser-message-projection.server";

/**
 * A task's own conversation as the message list shows it: the newest page of its messages, older
 * ones by `beforeSequence`, the way a direct conversation's is, with the people who can be
 * mentioned in it (the members of the board the task sits on). Whether the viewer reads it is the
 * board's to say (`ConversationHistory.authorize`); a conversation that is not a task's is not
 * found.
 */
export class TaskConversationPages {
  constructor(private readonly db: PrismaClient) {}

  private async authorize(workspaceId: string, userId: string, conversationId: string) {
    const access = await new ConversationHistory(this.db).authorize(
      workspaceId,
      userId,
      conversationId,
    );
    const task = await this.db.task.findUnique({
      where: { discussionConversationId: conversationId, ...LIVE_TASK_WHERE },
      select: {
        id: true,
        conversationId: true,
        number: true,
        message: { select: { mentions: BROWSER_MESSAGE_MENTIONS_SELECT } },
      },
    });
    if (!task) throw new AppError("NOT_FOUND");
    return { ...access, task };
  }

  async page(
    workspaceId: string,
    userId: string,
    conversationId: string,
    window: HistoryWindow = {},
  ) {
    const { activeMemberId, task } = await this.authorize(workspaceId, userId, conversationId);
    const limit = Math.min(window.limit ?? 50, 100);
    const forward = window.afterSequence !== undefined;
    const [rows, seat, newest, board, olderHeld] = await Promise.all([
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: forward
            ? { gt: window.afterSequence }
            : window.beforeSequence
              ? { lt: window.beforeSequence }
              : undefined,
        },
        orderBy: { sequence: forward ? ("asc" as const) : ("desc" as const) },
        take: limit + 1,
        select: browserMessageFields,
      }),
      activeMemberId
        ? this.db.$queryRaw<{ readThroughSequence: number; firstUnreadMessageId: string | null }[]>`
            SELECT cm."readThroughSequence", ${firstUnreadMessageIdSql} AS "firstUnreadMessageId"
            FROM "conversation_members" cm
            WHERE cm."id" = ${activeMemberId}::uuid AND cm."leftAt" IS NULL`.then(([row]) => row)
        : null,
      this.db.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { lastSequence: true },
      }),
      this.db.conversationMember.findMany({
        where: { conversationId: task.conversationId, leftAt: null },
        select: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              description: true,
              avatarObjectKey: true,
            },
          },
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              description: true,
              avatarMascot: true,
              visibility: true,
            },
          },
        },
      }),
      forward
        ? this.db.message.findFirst({
            where: { conversationId, threadRootId: null, sequence: { lte: window.afterSequence } },
            select: { id: true },
          })
        : null,
    ]);
    const flags = windowPageFlags(
      forward ? "forward" : window.beforeSequence ? "backward" : "initial",
      rows.length > limit,
    );
    const hasOlder = forward ? olderHeld !== null : flags.hasOlder;
    const { hasNewer } = flags;
    const pageRows = rows.slice(0, limit);
    const messages = forward ? pageRows : pageRows.reverse();
    return {
      kind: "task" as const,
      conversationId,
      taskNumber: task.number,
      viewerId: userId,
      // The viewer's seat keeps their read position; without one, whatever page this is, nothing is
      // unread for them.
      senderMemberId: activeMemberId,
      readThroughSequence: seat?.readThroughSequence ?? newest.lastSequence,
      firstUnreadMessageId: seat?.firstUnreadMessageId ?? null,
      othersReadThroughSequence: 0,
      threads: {},
      threadReadThrough: {},
      mentionables: conversationMentionables(workspaceId, board),
      hasOlder,
      hasNewer,
      messages: await mapBrowserMessages(this.db, messages, workspaceId),
    };
  }

  /**
   * How many top-level messages with a sender (never a system notice, never the viewer's own) lie
   * past the viewer's read position or their mark-as-unread marker, and the first one's id.
   */
  async unread(workspaceId: string, userId: string, conversationId: string) {
    const { activeMemberId } = await this.authorize(workspaceId, userId, conversationId);
    const empty = { unreadCount: 0, firstUnreadMessageId: null };
    if (!activeMemberId) return empty;
    const [unread] = await this.db.$queryRaw<
      { unreadCount: number; firstUnreadMessageId: string | null }[]
    >`
      SELECT (
        SELECT COUNT(*)::int FROM "messages" m WHERE ${conversationUnreadMessageSql}
      ) AS "unreadCount", ${firstUnreadMessageIdSql} AS "firstUnreadMessageId"
      FROM "conversation_members" cm
      WHERE cm."id" = ${activeMemberId}::uuid AND cm."leftAt" IS NULL`;
    return unread ?? empty;
  }

  /** What arrived after `afterSequence`. */
  async updates(
    workspaceId: string,
    userId: string,
    conversationId: string,
    afterSequence: number,
  ) {
    await this.authorize(workspaceId, userId, conversationId);
    return new PrismaDirectConversationRepository(this.db).updatesSince(
      workspaceId,
      conversationId,
      afterSequence,
    );
  }

  /**
   * The task's history events a page of the conversation owns, oldest first, as people read them.
   * An event belongs to the page holding the first message at or after it. `oldestSequence` and
   * `newestSequence` are the page's own oldest and newest messages; `newestSequence` is omitted for
   * the page holding the conversation's newest message. A conversation with no messages names
   * neither and gets every event.
   */
  async events(
    workspaceId: string,
    userId: string,
    conversationId: string,
    window: { oldestSequence?: number; newestSequence?: number },
  ) {
    const { task } = await this.authorize(workspaceId, userId, conversationId);
    const [through, after] = await Promise.all([
      window.newestSequence === undefined
        ? undefined
        : messageTime(this.db, conversationId, window.newestSequence),
      messageTimeUpTo(this.db, conversationId, (window.oldestSequence ?? 1) - 1),
    ]);
    if (window.newestSequence !== undefined && !through) throw new AppError("NOT_FOUND");
    return taskEventsInWindow(this.db, task.id, "people", taskMentions(task), { after, through });
  }
}
