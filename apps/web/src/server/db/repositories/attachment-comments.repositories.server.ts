import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type {
  AttachmentCommentAccess,
  AttachmentCommentActor,
  AttachmentCommentPageInput,
  AttachmentCommentPostInput,
  AttachmentCommentStore,
  AttachmentCommentView,
} from "#src/server/attachments/attachment-comments.server";
import { AppError } from "#src/lib/app-error";
import { parseAttachmentCommentAnchor } from "#src/features/conversations/attachment-comment-anchors";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";

export class PrismaAttachmentCommentStore implements AttachmentCommentStore {
  constructor(private readonly db: PrismaClient) {}

  access(actor: AttachmentCommentActor, attachmentId: string) {
    return readAccess(this.db, actor, attachmentId);
  }

  async list(input: AttachmentCommentPageInput) {
    const limit = clampPageLimit(input.limit ?? 30, 100);
    const rows = await this.db.attachmentComment.findMany({
      where: {
        attachmentId: input.attachmentId,
        message: {
          threadRootId: null,
          ...(input.beforeSequence ? { sequence: { lt: input.beforeSequence } } : {}),
        },
      },
      orderBy: { message: { sequence: "desc" } },
      take: limit + 1,
      include: { message: { select: browserMessageFields } },
    });
    return {
      comments: rows.slice(0, limit).reverse().map(commentView),
      hasOlder: rows.length > limit,
    };
  }

  async post(
    actor: AttachmentCommentActor,
    input: AttachmentCommentPostInput,
    authorize: (access: AttachmentCommentAccess | null) => void,
  ) {
    const attachment = await this.db.attachment.findUnique({
      where: { id: input.attachmentId, workspaceId: actor.workspaceId },
      select: { conversationId: true },
    });
    if (!attachment) throw new AppError("NOT_FOUND");
    return this.db.$transaction(async (tx) => {
      // Match source-channel writers/deletion before taking the attachment and discussion locks.
      await lockConversation(tx, attachment.conversationId);
      await tx.$queryRaw`SELECT id FROM attachments WHERE id = ${input.attachmentId}::uuid FOR UPDATE`;
      const access = await readAccess(tx, actor, input.attachmentId);
      authorize(access);
      if (!access || access.sourceConversationId !== attachment.conversationId)
        throw new AppError("CONFLICT");
      let conversationId = access.conversationId;
      if (!conversationId) {
        const conversation = await tx.conversation.create({
          data: {
            workspaceId: actor.workspaceId,
            kind: "attachment_comments",
          },
        });
        await tx.attachmentCommentThread.create({
          data: {
            attachmentId: input.attachmentId,
            workspaceId: actor.workspaceId,
            conversationId: conversation.id,
          },
        });
        conversationId = conversation.id;
      }
      await lockConversation(tx, conversationId);
      const member =
        actor.userId !== undefined
          ? await tx.conversationMember.upsert({
              where: { conversationId_userId: { conversationId, userId: actor.userId } },
              create: { workspaceId: actor.workspaceId, conversationId, userId: actor.userId },
              update: { leftAt: null },
            })
          : await tx.conversationMember.upsert({
              where: { conversationId_agentId: { conversationId, agentId: actor.agentId } },
              create: { workspaceId: actor.workspaceId, conversationId, agentId: actor.agentId },
              update: { leftAt: null },
            });
      const latest = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const message = await tx.message.create({
        data: {
          workspaceId: actor.workspaceId,
          conversationId,
          senderMemberId: member.id,
          body: input.body,
          sequence: (latest?.sequence ?? 0) + 1,
        },
      });
      const comment = await tx.attachmentComment.create({
        data: {
          attachmentId: input.attachmentId,
          workspaceId: actor.workspaceId,
          conversationId,
          messageId: message.id,
          anchorType: input.anchor?.type,
          anchorData: input.anchor?.data,
        },
        include: { message: { select: browserMessageFields } },
      });
      return commentView(comment);
    });
  }
}

async function readAccess(
  db: DatabaseScope,
  actor: AttachmentCommentActor,
  attachmentId: string,
): Promise<AttachmentCommentAccess | null> {
  const memberWhere: Prisma.ConversationMemberWhereInput = actor.userId
    ? { userId: actor.userId }
    : { agentId: actor.agentId };
  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      workspaceId: true,
      fileName: true,
      contentType: true,
      conversationId: true,
      messageId: true,
      commentThread: { select: { conversationId: true } },
      conversation: {
        select: {
          channelName: true,
          kind: true,
          hiddenFromWorkspaceAt: true,
          archivedAt: true,
          members: {
            where: { OR: [memberWhere, { agent: { deletedAt: { not: null } } }] },
            select: {
              userId: true,
              agentId: true,
              leftAt: true,
              agent: { select: { deletedAt: true } },
            },
          },
        },
      },
    },
  });
  if (!attachment || attachment.workspaceId !== actor.workspaceId) return null;
  const source = attachment.conversation;
  const member = source.members.find((row) =>
    actor.userId ? row.userId === actor.userId : row.agentId === actor.agentId,
  );
  let workspaceMember = false;
  if (actor.userId)
    workspaceMember = Boolean(
      await db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
        select: { userId: true },
      }),
    );
  else
    workspaceMember = Boolean(
      await db.agent.findFirst({
        where: {
          id: actor.agentId,
          workspaceId: actor.workspaceId,
          deletedAt: null,
          owner: { memberships: { some: { workspaceId: actor.workspaceId } } },
        },
        select: { id: true },
      }),
    );
  const directVisible =
    source.channelName !== null ||
    !actor.userId ||
    Boolean(
      await db.conversation.findFirst({
        where: { id: attachment.conversationId, ...viewerDirectConversationWhere(actor.userId) },
        select: { id: true },
      }),
    );
  const activeMember = Boolean(member && member.leftAt === null);
  return {
    workspaceId: actor.workspaceId,
    attachmentId,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sourceConversationId: attachment.conversationId,
    conversationId: attachment.commentThread?.conversationId ?? null,
    canRead:
      workspaceMember &&
      directVisible &&
      source.hiddenFromWorkspaceAt === null &&
      Boolean(attachment.messageId || attachment.commentThread) &&
      (Boolean(actor.userId && source.channelName !== null) || activeMember),
    activeMember,
    archived: source.archivedAt !== null,
    readOnly:
      source.kind !== null ||
      (source.channelName === null && source.members.some((row) => row.agent?.deletedAt)),
  };
}

type CommentRow = Prisma.AttachmentCommentGetPayload<{
  include: { message: { select: typeof browserMessageFields } };
}>;
function commentView(row: CommentRow): AttachmentCommentView {
  const message = mapBrowserMessage(row.message, row.workspaceId);
  return {
    ...message,
    anchor: parseAttachmentCommentAnchor(
      row.anchorType ? { type: row.anchorType, data: row.anchorData } : null,
    ),
    resolved: message.reactions?.some((reaction) => reaction.emoji === "✅") ?? false,
    replyTarget: `attachment:${row.attachmentId}:${row.messageId}`,
  };
}
