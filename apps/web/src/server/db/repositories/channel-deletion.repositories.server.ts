import type { PrismaClient } from "#src/generated/prisma/client";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { deleteAttachmentRows } from "./attachment-deletion.repositories.server";

/** Persistence after PublicChannels authorizes deletion; the source lock fences concurrent comments. */
export function deleteChannelRows(
  db: PrismaClient,
  input: { workspaceId: string; conversationId: string; channelName: string },
) {
  return db.$transaction(async (tx) => {
    await lockConversation(tx, input.conversationId);
    await tx.reminder.updateMany({
      where: {
        workspaceId: input.workspaceId,
        status: "scheduled",
        OR: [
          { target: `#${input.channelName}` },
          { target: { startsWith: `#${input.channelName}:` } },
        ],
      },
      data: { status: "canceled" },
    });
    await deleteAttachmentRows(tx, { conversationId: input.conversationId });
    // Messages name their sender/Task members with Restrict; they go before member cascades.
    await tx.message.deleteMany({ where: { conversationId: input.conversationId } });
    await tx.conversation.delete({ where: { id: input.conversationId } });
  });
}
