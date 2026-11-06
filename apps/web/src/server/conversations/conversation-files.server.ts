import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import {
  attachmentView,
  ATTACHMENT_VIEW_SELECT,
} from "#src/server/attachments/attachment-view.server";
import { isInlineImage } from "#src/server/attachments/attachment-response.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";

export async function listConversationFiles(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; conversationId: string },
) {
  await new ConversationHistory(db).authorize(
    input.workspaceId,
    input.userId,
    input.conversationId,
  );
  const attachments = await db.attachment.findMany({
    // An upload lands with `messageId` null and only a sent message claims it, so this lists
    // files that were sent — never one someone uploaded and did not send (task #617).
    where: {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      messageId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      ...ATTACHMENT_VIEW_SELECT,
      createdAt: true,
      message: { select: { id: true } },
      uploader: { select: { username: true, displayName: true } },
      uploaderAgent: { select: { displayName: true, name: true } },
    },
  });
  return {
    files: attachments.map((attachment) => {
      const view = attachmentView(attachment);
      return {
        ...view,
        createdAt: attachment.createdAt.toISOString(),
        // A HEIC is drawn too, from its WebP icon.
        inlineImage: isInlineImage(attachment.contentType) || view.iconUrl !== undefined,
        sender: attachment.uploader
          ? humanLabel(attachment.uploader)
          : attachment.uploaderAgent?.displayName || attachment.uploaderAgent?.name || "",
        messageId: attachment.message?.id ?? null,
      };
    }),
  };
}
