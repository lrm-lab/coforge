import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type {
  AttachmentCommentAccess,
  AttachmentCommentActor,
  AttachmentCommentPageInput,
  AttachmentCommentPostInput,
  AttachmentCommentPosted,
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
import {
  channelMentionTargets,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";
import { PENDING_MENTION_ACTION_TTL_MS } from "#src/server/conversations/pending-mention-action-recording.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { writeReaction, type ReactionPort } from "#src/server/conversations/reaction-write.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import { commentRecipients, readAccess } from "./attachment-comment-recipients.repositories.server";

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

  async list(input: AttachmentCommentPageInput, commentsRootId: string | null = null) {
    const limit = clampPageLimit(input.limit ?? 30, 100);
    const rows = await this.db.attachmentComment.findMany({
      where: {
        attachmentId: input.attachmentId,
        message: {
          threadRootId: input.rootId ?? commentsRootId,
          ...(input.beforeSequence ? { sequence: { lt: input.beforeSequence } } : {}),
        },
      },
      orderBy: { message: { sequence: "desc" } },
      take: limit + 1,
      include: {
        message: { select: browserMessageFields },
        thread: { select: { attachmentId: true } },
      },
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
  ): Promise<AttachmentCommentPosted> {
    const attachment = await this.db.attachment.findUnique({
      where: { id: input.attachmentId, workspaceId: actor.workspaceId },
      select: { conversationId: true, uploaderId: true, uploaderAgentId: true },
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
      // A top-level comment on a migrated attachment threads under its source message, the
      // same place the migration parked the comments it moved.
      const threadRootId = input.rootId
        ? await rootOf(tx, input.attachmentId, input.rootId)
        : conversationId === attachment.conversationId
          ? access.commentsRootId
          : null;
      const member = await joinDiscussion(tx, actor, conversationId);
      // `@handle`s and `--mention` bindings resolve among the SOURCE conversation's active
      // members: a comment can name whoever could read the file's own place. `storeMessageBody`
      // also resolves `task #N`/`#channel`/`#channel:anchor` references; channel and thread
      // references resolve only where the commenter may read, and `task #N` resolves wherever
      // the comment lands — a comment conversation holds none, a migrated source conversation
      // resolves its own tasks.
      const stored = await storeMessageBody(
        tx,
        {
          workspaceId: actor.workspaceId,
          conversationId,
          reader:
            actor.userId !== undefined ? { userId: actor.userId } : { agentId: actor.agentId },
        },
        input.body,
        {
          targets: (handles) =>
            channelMentionTargets(
              tx,
              { workspaceId: actor.workspaceId, conversationId: attachment.conversationId },
              handles,
            ),
          bindings: input.mentions,
        },
      );
      // A mention's row needs its target seated in the COMMENT conversation. Mentions resolved
      // against the source's roster, so seat each now; the seat is never authority.
      const mentionMemberIdByKey = new Map<string, string>();
      for (const mention of stored.mentions) {
        const seated = await joinDiscussion(
          tx,
          mention.type === "user"
            ? { workspaceId: actor.workspaceId, userId: mention.id }
            : { workspaceId: actor.workspaceId, agentId: mention.id },
          conversationId,
        );
        mentionMemberIdByKey.set(mention.key, seated.id);
      }
      const recipients = await commentRecipients(tx, {
        workspaceId: actor.workspaceId,
        attachmentId: input.attachmentId,
        sourceConversationId: attachment.conversationId,
        commentConversationId: conversationId,
        author: actor,
        uploaderId: attachment.uploaderId,
        uploaderAgentId: attachment.uploaderAgentId,
        mentions: stored.mentions,
      });
      const sequence = await allocateSequence(tx, conversationId);
      const message = await tx.message.create({
        data: {
          workspaceId: actor.workspaceId,
          conversationId,
          senderMemberId: member.id,
          body: stored.body,
          threadRootId,
          sequence,
          mentions: stored.mentions.length
            ? {
                create: stored.mentions.map((mention) => ({
                  memberId: mentionMemberIdByKey.get(mention.key)!,
                  workspaceId: actor.workspaceId,
                  kind: mention.type,
                  actorId: mention.id,
                  handle: mention.handle,
                })),
              }
            : undefined,
          deliveries: recipients.agents.size
            ? {
                create: [...recipients.agents].map(([agentId, reason]) => ({
                  workspaceId: actor.workspaceId,
                  conversationId,
                  agentId,
                  sequence,
                  reason,
                })),
              }
            : undefined,
        },
        include: { deliveries: { select: { deliveryId: true, agentId: true } } },
      });
      if (recipients.users.size)
        await tx.pendingMentionAction.createMany({
          data: [...recipients.users].map(([userId, recipient]) => ({
            messageId: message.id,
            conversationId,
            workspaceId: actor.workspaceId,
            senderMemberId: member.id,
            targetUserId: userId,
            targetHandle: recipient.handle,
            expiresAt: new Date(message.createdAt.getTime() + PENDING_MENTION_ACTION_TTL_MS),
            // Surfaced as an Activity item at once; the resolved-action CHECK keeps resolvedAt
            // null, and `reason` is what keeps the row out of the sender's actionable lists.
            notifiedAt: message.createdAt,
            reason: recipient.reason,
          })),
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
        include: {
          message: { select: browserMessageFields },
          thread: { select: { attachmentId: true } },
        },
      });
      return {
        comment: commentView(comment, 0),
        notified: {
          workspaceId: actor.workspaceId,
          attachmentId: input.attachmentId,
          userIds: [...recipients.users.keys()],
          deliveries: message.deliveries,
        },
      };
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

type CommentRow = Prisma.AttachmentCommentGetPayload<{
  include: {
    message: { select: typeof browserMessageFields };
    thread: { select: { attachmentId: true } };
  };
}>;
function commentView(row: CommentRow, replyCount: number): AttachmentCommentView {
  const message = mapBrowserMessage(row.message, row.workspaceId);
  return {
    ...message,
    anchor: parseAttachmentCommentAnchor(
      row.anchorType ? { type: row.anchorType, data: row.anchorData } : null,
    ),
    resolved: message.reactions?.some((reaction) => reaction.emoji === "✅") ?? false,
    // A reply names its thread root while comments have one; after migration the message's own
    // root is the source message, so the comment anchors by its own id instead.
    replyTarget: `attachment:${row.attachmentId}:${
      row.thread ? (row.message.threadRootId ?? row.messageId) : row.messageId
    }`,
    replyCount,
  };
}
