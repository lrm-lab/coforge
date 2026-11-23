import { ATTACHMENT_VIEW_SELECT, type AttachmentViewRow } from "./attachment-view.server";
import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";

/** Delegated uploads remain attributed to the private assistant that uploaded them. */
export function userUploadedAttachmentWhere(userId: string): Prisma.AttachmentWhereInput {
  return {
    OR: [
      { uploaderId: userId },
      {
        uploaderAgent: {
          ownerId: userId,
          systemKind: WORKSPACE_ASSISTANT_KIND,
          deletedAt: null,
          workspaceAssistantSession: { userId },
        },
      },
    ],
  };
}

type ClaimedAttachment = AttachmentViewRow;

/**
 * The uploads a person's new message carries, in send order: each must be theirs, in this
 * conversation, and not yet part of a message. Call before creating the message, then
 * `attachToMessage` once it exists, in the same transaction.
 */
export async function claimUploadedAttachments(
  tx: Pick<Prisma.TransactionClient, "attachment">,
  scope: { workspaceId: string; conversationId: string; uploaderId: string },
  attachmentIds: readonly string[],
): Promise<ClaimedAttachment[]> {
  if (!attachmentIds.length) return [];
  const available = await tx.attachment.findMany({
    where: {
      id: { in: [...new Set(attachmentIds)] },
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      ...userUploadedAttachmentWhere(scope.uploaderId),
      messageId: null,
    },
    select: ATTACHMENT_VIEW_SELECT,
  });
  const byId = new Map(available.map((attachment) => [attachment.id, attachment]));
  const missingIds = [...new Set(attachmentIds.filter((id) => !byId.has(id)))];
  if (missingIds.length > 0) {
    throw new AppError("ATTACHMENTS_UNAVAILABLE", {
      details: { attachmentIds: missingIds.join(",") },
    });
  }
  return attachmentIds.map((attachmentId) => byId.get(attachmentId)!);
}

/** Links claimed uploads to their message, keeping send order as `position`. */
export async function attachToMessage(
  tx: Pick<Prisma.TransactionClient, "attachment">,
  messageId: string,
  attachments: readonly { id: string }[],
) {
  await Promise.all(
    attachments.map((attachment, position) =>
      tx.attachment.update({ where: { id: attachment.id }, data: { messageId, position } }),
    ),
  );
}
