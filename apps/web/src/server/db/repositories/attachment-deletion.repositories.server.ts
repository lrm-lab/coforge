import type { Prisma } from "#src/generated/prisma/client";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";

/** Delete discussion Messages before their author seats, then the files' rows. Callers own
 * authorization and remove the returned storage keys only after the surrounding commit. */
export function deleteAttachmentRows(db: DatabaseScope, where: Prisma.AttachmentWhereInput) {
  return inTransaction(db, async (tx) => {
    const attachments = await tx.attachment.findMany({
      where,
      select: { conversationId: true, objectKey: true },
    });
    for (const id of [...new Set(attachments.map((row) => row.conversationId))].sort())
      await lockConversation(tx, id);
    const threads = await tx.attachmentCommentThread.findMany({
      where: { attachment: where },
      select: { conversationId: true },
    });
    const conversationIds = threads.map((row) => row.conversationId).sort();
    for (const id of conversationIds) await lockConversation(tx, id);
    await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    const result = await tx.attachment.deleteMany({ where });
    return { ...result, objectKeys: attachments.map((row) => row.objectKey) };
  });
}
