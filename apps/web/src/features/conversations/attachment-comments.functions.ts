import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { attachmentCommentNotices } from "#src/server/attachments/attachment-comment-notices.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { attachmentCommentAnchor } from "./attachment-comment-anchors";
import { mentionSelectorsSchema, toggleMessageReactionInputSchema } from "./conversation.schemas";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";

const attachmentIdInput = z.object({ attachmentId: z.uuid() });

export const loadAttachmentComments = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    attachmentIdInput.extend({
      rootId: z.uuid().optional(),
      beforeSequence: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  )
  .handler(({ context, data }) =>
    new AttachmentComments(new PrismaAttachmentCommentStore(context.db)).list(
      { workspaceId: context.workspaceId, userId: context.user.id },
      data,
    ),
  );

export const postAttachmentComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    attachmentIdInput.extend({
      idempotencyKey: z.uuid(),
      body: z.string().trim().min(1).max(8_000),
      anchor: attachmentCommentAnchor.optional(),
      rootId: z.uuid().optional(),
      mentions: mentionSelectorsSchema,
    }),
  )
  .handler(({ context, data }) => {
    const { idempotencyKey, ...input } = data;
    // The same duplicate suppression every send goes through: a retried key returns the comment
    // it first posted instead of writing a second one.
    return getMessageRequestIdempotency().execute(
      {
        workspaceId: context.workspaceId,
        senderKind: "user",
        senderId: context.user.id,
        idempotencyKey,
      },
      async () => {
        const posted = await new AttachmentComments(
          new PrismaAttachmentCommentStore(context.db),
        ).post(
          { workspaceId: context.workspaceId, userId: context.user.id },
          input,
          attachmentCommentNotices(context.db, createCentrifugoServerApi()),
        );
        return {
          id: posted.id,
          body: posted.body,
          createdAt: new Date(posted.createdAt),
          sequence: posted.sequence,
          threadRootId: posted.threadRootId ?? null,
          attachments: [],
          workspaceId: context.workspaceId,
          target: `attachment:${input.attachmentId}`,
        };
      },
    );
  });

export const reactAttachmentComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(attachmentIdInput.extend(toggleMessageReactionInputSchema.shape))
  .handler(({ context, data }) =>
    new AttachmentComments(new PrismaAttachmentCommentStore(context.db)).react(
      { workspaceId: context.workspaceId, userId: context.user.id },
      data,
    ),
  );
