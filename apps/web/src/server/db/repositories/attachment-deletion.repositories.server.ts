import type { Prisma } from "#src/generated/prisma/client";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";
import { lockConversations } from "#src/server/conversations/conversation-lock.server";

export function deleteAttachmentRows(db: DatabaseScope, where: Prisma.AttachmentWhereInput) {
  return inTransaction(db, async (tx) => {
    const attachments = await tx.attachment.findMany({
      where,
      select: { conversationId: true, objectKey: true },
    });
    await lockConversations(
      tx,
      attachments.map((row) => row.conversationId),
    );
    const threads = await tx.attachmentCommentThread.findMany({
      where: { attachment: where },
      select: { conversationId: true },
    });
    const conversationIds = [...new Set(threads.map((row) => row.conversationId))].sort();
    await lockConversations(tx, conversationIds);
    await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    const result = await tx.attachment.deleteMany({ where });
    return { ...result, objectKeys: attachments.map((row) => row.objectKey) };
  });
}
