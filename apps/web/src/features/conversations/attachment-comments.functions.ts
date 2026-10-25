import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { attachmentCommentAnchor } from "./attachment-comment-anchors";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";

const attachmentIdInput = z.object({ attachmentId: z.uuid() });

export const loadAttachmentComments = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    attachmentIdInput.extend({
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
      body: z.string().trim().min(1).max(8_000),
      anchor: attachmentCommentAnchor.optional(),
    }),
  )
  .handler(({ context, data }) =>
    new AttachmentComments(new PrismaAttachmentCommentStore(context.db)).post(
      { workspaceId: context.workspaceId, userId: context.user.id },
      data,
    ),
  );
