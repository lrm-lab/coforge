import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { canReadChannel } from "./channel-read-access.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { taskDiscussionAccess, taskDiscussionBoardSelect } from "./task-discussion-access.server";
import { AppError } from "#src/lib/app-error";
import { followedThreadRootIds, readWindowThreads } from "./thread-summaries.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { findLinkedMessage } from "#src/server/db/message-anchor.server";
import { actionCardViews } from "./action-card-views.server";
import {
  browserMessageFields,
  mapBrowserMessages,
  type BrowserMessageRow,
} from "./browser-message-projection.server";
import { mapBrowserMessagesWithViewerViews } from "./viewer-views.server";

export function messagesArrivedWhere(
  conversationId: string,
  afterSequence: number,
  afterReplySequence: number = afterSequence,
): Prisma.MessageWhereInput {
  if (afterReplySequence === afterSequence)
    return { conversationId, sequence: { gt: afterSequence } };
  return {
    conversationId,
    OR: [
      { threadRootId: null, sequence: { gt: afterSequence } },
      { threadRootId: { not: null }, sequence: { gt: afterReplySequence } },
    ],
  };
}

async function hydrateMessagesInOrder(
  db: Pick<PrismaClient, "message">,
  conversationId: string,
  orderedIds: readonly string[],
): Promise<BrowserMessageRow[]> {
  if (orderedIds.length === 0) return [];
  const rows = await db.message.findMany({
    where: { id: { in: [...orderedIds] }, conversationId },
    select: browserMessageFields,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return orderedIds.flatMap((id) => {
    const message = byId.get(id);
    return message ? [message] : [];
  });
}

export async function browserMessageUpdates(
  db: Pick<PrismaClient, "message">,
  conversationId: string,
  afterSequence: number,
  afterReplySequence?: number,
): Promise<BrowserMessageRow[]> {
  const arrived = await db.message.findMany({
    where: messagesArrivedWhere(conversationId, afterSequence, afterReplySequence),
    orderBy: { sequence: "asc" },
    take: 100,
    select: { id: true },
  });
  return hydrateMessagesInOrder(
    db,
    conversationId,
    arrived.map((row) => row.id),
  );
}

export class ConversationHistory {
  constructor(private readonly db: PrismaClient) {}

  async authorize(
    workspaceId: string,
    userId: string,
    conversationId: string,
  ): Promise<{
    viewerMemberId: string | undefined;
    activeMemberId: string | undefined;
    direct: boolean;
  }> {
    const [membership, conversation] = await Promise.all([
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { userId: true },
      }),
      this.db.conversation.findFirst({
        where: { id: conversationId, workspaceId, ...VISIBLE_CONVERSATION_WHERE },
        select: {
          directKey: true,
          channelName: true,
          visibility: true,
          kind: true,
          members: { where: { userId }, select: { id: true, leftAt: true } },
          ...taskDiscussionBoardSelect({ userId }),
        },
      }),
    ]);
    if (!membership) throw new AppError("ACCESS_DENIED");
    if (!conversation) throw new AppError("NOT_FOUND");
    const viewer = conversation.members[0];
    const viewerMemberId = viewer?.id;
    const activeMemberId = viewer?.leftAt === null ? viewer.id : undefined;
    if (conversation.kind === "task_thread") {
      if (taskDiscussionAccess(conversation) !== "read") throw new AppError("NOT_FOUND");
      return { viewerMemberId, activeMemberId, direct: true };
    }
    if (conversation.channelName !== null) {
      if (!canReadChannel(conversation, activeMemberId !== undefined))
        throw new AppError("NOT_FOUND");
      return { viewerMemberId, activeMemberId, direct: false };
    }
    if (conversation.directKey !== null && viewerMemberId)
      return { viewerMemberId, activeMemberId, direct: true };
    throw new AppError("ACCESS_DENIED");
  }

  async loadAround(
    workspaceId: string,
    userId: string,
    conversationId: string,
    messageId: string,
    requestedLimit = 41,
    options?: { includeViewerViews?: boolean },
  ) {
    const { activeMemberId, direct } = await this.authorize(workspaceId, userId, conversationId);
    const anchor = await findLinkedMessage(this.db, conversationId, messageId, {
      id: true,
      sequence: true,
      threadRoot: { select: { id: true, sequence: true } },
    });
    if (!anchor) throw new AppError("NOT_FOUND");
    const center = anchor.threadRoot ?? anchor;

    const limit = clampPageLimit(requestedLimit, 81);
    const beforeCount = Math.floor((limit - 1) / 2);
    const afterCount = limit - beforeCount - 1;
    const [beforeIds, afterIds] = await Promise.all([
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: { lte: center.sequence },
        },
        orderBy: { sequence: "desc" },
        take: beforeCount + 2,
        select: { id: true },
      }),
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: { gt: center.sequence },
        },
        orderBy: { sequence: "asc" },
        take: afterCount + 1,
        select: { id: true },
      }),
    ]);
    const rootIds = [
      ...beforeIds.slice(0, beforeCount + 1).reverse(),
      ...afterIds.slice(0, afterCount),
    ].map((row) => row.id);
    const [browserMessages, { threads, threadReadThrough, threadUnreadMarks }, followed] =
      await Promise.all([
        options?.includeViewerViews
          ? Promise.all([
              hydrateMessagesInOrder(this.db, conversationId, rootIds),
              rootIds.length > 0
                ? actionCardViews(this.db, workspaceId, userId, rootIds, {
                    authorizedConversationId: conversationId,
                  })
                : Promise.resolve(new Map()),
            ]).then(([roots, preloadedCards]) =>
              mapBrowserMessagesWithViewerViews(this.db, roots, workspaceId, userId, {
                authorizedConversationId: conversationId,
                actionCards: Promise.resolve(preloadedCards),
              }),
            )
          : hydrateMessagesInOrder(this.db, conversationId, rootIds).then((roots) =>
              mapBrowserMessages(this.db, roots, workspaceId),
            ),
        readWindowThreads(this.db, {
          workspaceId,
          conversationId,
          rootIds,
          viewerMemberId: activeMemberId,
        }),
        direct ? [] : followedThreadRootIds(this.db, { viewerMemberId: activeMemberId, rootIds }),
      ]);
    return {
      conversationId,
      hasOlder: beforeIds.length > beforeCount + 1,
      hasNewer: afterIds.length > afterCount,
      anchorMessageId: anchor.id,
      anchorThreadRootId: anchor.threadRoot?.id,
      messages: browserMessages,
      threads,
      threadReadThrough,
      ...(threadUnreadMarks && { threadUnreadMarks }),
      followedThreadRootIds: followed,
    };
  }

  async loadThread(
    workspaceId: string,
    userId: string,
    conversationId: string,
    threadRootId: string,
    options?: { includeViewerViews?: boolean },
  ) {
    await this.authorize(workspaceId, userId, conversationId);
    const [root, replyIdRows] = await Promise.all([
      this.db.message.findFirst({
        where: { id: threadRootId, conversationId, threadRootId: null },
        select: { id: true },
      }),
      this.db.message.findMany({
        where: { conversationId, threadRootId },
        orderBy: { sequence: "asc" },
        select: { id: true },
      }),
    ]);
    if (!root) throw new AppError("NOT_FOUND");
    const replyIds = replyIdRows.map((row) => row.id);
    if (replyIds.length === 0) return { replies: [] };
    if (options?.includeViewerViews) {
      const [replies, preloadedCards] = await Promise.all([
        hydrateMessagesInOrder(this.db, conversationId, replyIds),
        actionCardViews(this.db, workspaceId, userId, replyIds, {
          authorizedConversationId: conversationId,
        }),
      ]);
      return {
        replies: await mapBrowserMessagesWithViewerViews(this.db, replies, workspaceId, userId, {
          authorizedConversationId: conversationId,
          actionCards: Promise.resolve(preloadedCards),
        }),
      };
    }
    const replies = await hydrateMessagesInOrder(this.db, conversationId, replyIds);
    return { replies: await mapBrowserMessages(this.db, replies, workspaceId) };
  }
}
