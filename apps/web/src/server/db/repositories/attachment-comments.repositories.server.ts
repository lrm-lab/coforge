import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import { canReadChannel } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type {
  AttachmentCommentAccess,
  AttachmentCommentActor,
  AttachmentCommentPageInput,
  AttachmentCommentPostInput,
  AttachmentCommentReactInput,
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
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { writeReaction, type ReactionPort } from "#src/server/conversations/reaction-write.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";

/**
 * Comment reactions are announced to no one: no page follows a discussion's realtime channel (the
 * comments pane reads it again instead), and without a port of its own a reaction write would
 * publish there anyway.
 */
const UNANNOUNCED: ReactionPort = {};

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
          threadRootId: input.rootId ?? null,
          ...(input.beforeSequence ? { sequence: { lt: input.beforeSequence } } : {}),
        },
      },
      orderBy: { message: { sequence: "desc" } },
      take: limit + 1,
      include: { message: { select: browserMessageFields } },
    });
    const page = rows.slice(0, limit).reverse();
    // Counted for root comments only: a reply has none of its own.
    const counts =
      input.rootId || page.length === 0
        ? []
        : await this.db.message.groupBy({
            by: ["threadRootId"],
            where: { threadRootId: { in: page.map((row) => row.messageId) } },
            _count: { _all: true },
          });
    const replies = new Map(counts.map((row) => [row.threadRootId, row._count._all]));
    return {
      comments: page.map((row) => commentView(row, replies.get(row.messageId) ?? 0)),
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
      const threadRootId = input.rootId ? await rootOf(tx, input.attachmentId, input.rootId) : null;
      const member = await joinDiscussion(tx, actor, conversationId);
      const sequence = await allocateSequence(tx, conversationId);
      const message = await tx.message.create({
        data: {
          workspaceId: actor.workspaceId,
          conversationId,
          senderMemberId: member.id,
          body: input.body,
          threadRootId,
          sequence,
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
      return commentView(comment, 0);
    });
  }

  async react(
    actor: AttachmentCommentActor,
    input: AttachmentCommentReactInput,
    authorize: (access: AttachmentCommentAccess | null) => void,
  ) {
    const [access, comment] = await Promise.all([
      readAccess(this.db, actor, input.attachmentId),
      this.db.attachmentComment.findFirst({
        where: { messageId: input.messageId, attachmentId: input.attachmentId },
        select: { conversationId: true, message: { select: { threadRootId: true } } },
      }),
    ]);
    authorize(access);
    if (!comment) throw new AppError("NOT_FOUND");
    // The attachment, and with it the discussion, was deleted after it was found.
    const member = await joinDiscussion(this.db, actor, comment.conversationId).catch((error) => {
      throw hasErrorCode(error, "P2003") ? new AppError("NOT_FOUND") : error;
    });
    const written = await writeReaction(this.db, UNANNOUNCED, {
      workspaceId: actor.workspaceId,
      conversationId: comment.conversationId,
      messageId: input.messageId,
      threadRootId: comment.message.threadRootId,
      memberId: member.id,
      emoji: input.emoji,
      active: input.active,
    });
    // The comment was deleted after it was found.
    if (!written) throw new AppError("NOT_FOUND");
    return written;
  }
}

/**
 * The root comment a reply joins: `rootId` itself when it is a root comment on this attachment,
 * or the root of the reply it names.
 */
async function rootOf(db: DatabaseScope, attachmentId: string, rootId: string) {
  const named = await db.attachmentComment.findFirst({
    where: { messageId: rootId, attachmentId },
    select: { message: { select: { threadRootId: true } } },
  });
  if (!named) throw new AppError("NOT_FOUND");
  return named.message.threadRootId ?? rootId;
}

/** The actor's seat in the discussion, taken (or taken back) by commenting or reacting in it. */
function joinDiscussion(db: DatabaseScope, actor: AttachmentCommentActor, conversationId: string) {
  return actor.userId !== undefined
    ? db.conversationMember.upsert({
        where: { conversationId_userId: { conversationId, userId: actor.userId } },
        create: { workspaceId: actor.workspaceId, conversationId, userId: actor.userId },
        update: { leftAt: null },
      })
    : db.conversationMember.upsert({
        where: { conversationId_agentId: { conversationId, agentId: actor.agentId } },
        create: { workspaceId: actor.workspaceId, conversationId, agentId: actor.agentId },
        update: { leftAt: null },
      });
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
      sizeBytes: true,
      conversationId: true,
      messageId: true,
      commentThread: { select: { conversationId: true } },
      conversation: {
        select: {
          channelName: true,
          visibility: true,
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
    sizeBytes: attachment.sizeBytes,
    sourceConversationId: attachment.conversationId,
    conversationId: attachment.commentThread?.conversationId ?? null,
    canRead:
      workspaceMember &&
      directVisible &&
      source.hiddenFromWorkspaceAt === null &&
      Boolean(attachment.messageId || attachment.commentThread) &&
      (actor.userId && source.channelName !== null
        ? canReadChannel(source, activeMember)
        : activeMember),
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
function commentView(row: CommentRow, replyCount: number): AttachmentCommentView {
  const message = mapBrowserMessage(row.message, row.workspaceId);
  return {
    ...message,
    anchor: parseAttachmentCommentAnchor(
      row.anchorType ? { type: row.anchorType, data: row.anchorData } : null,
    ),
    resolved: message.reactions?.some((reaction) => reaction.emoji === "✅") ?? false,
    replyTarget: `attachment:${row.attachmentId}:${row.message.threadRootId ?? row.messageId}`,
    replyCount,
  };
}
