import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { windowPageFlags } from "#src/lib/conversation-window";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { HistoryWindow } from "#src/server/db/repositories/direct-conversation-types.server";
import { conversationMentionables } from "#src/server/db/repositories/user-direct-reads.repositories.server";
import {
  browserMessageFields,
  ConversationHistory,
  mapBrowserMessage,
} from "./conversation-history.server";

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
      where: { discussionConversationId: conversationId },
      select: { conversationId: true, number: true },
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
    const [rows, seat, newest, board] = await Promise.all([
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
        ? this.db.conversationMember.findUnique({
            where: { id: activeMemberId },
            select: { readThroughSequence: true },
          })
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
            },
          },
        },
      }),
    ]);
    const { hasOlder, hasNewer } = windowPageFlags(
      forward ? "forward" : window.beforeSequence ? "backward" : "initial",
      rows.length > limit,
    );
    const pageRows = rows.slice(0, limit);
    const messages = forward ? pageRows : pageRows.reverse();
    return {
      kind: "task" as const,
      conversationId,
      taskNumber: task.number,
      viewerId: userId,
      // The viewer's seat keeps their read position; without one, whatever page this is, nothing is
      // unread for them.
      senderMemberId: activeMemberId ?? null,
      readThroughSequence: seat?.readThroughSequence ?? newest.lastSequence,
      othersReadThroughSequence: 0,
      threads: [],
      threadReadThrough: {},
      mentionables: conversationMentionables(workspaceId, board),
      hasOlder,
      hasNewer,
      messages: messages.map((message) => mapBrowserMessage(message, workspaceId)),
    };
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
}
