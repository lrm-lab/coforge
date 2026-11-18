import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import {
  conversationTarget,
  TARGET_CONVERSATION_SELECT,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import type { Transaction } from "./task-board-ports.server";

export async function attachmentInOtherConversation(
  tx: Transaction,
  input: {
    workspaceId: string;
    conversationId: string;
    missingIds: readonly string[];
    uploader: Prisma.AttachmentWhereInput;
    agentId: string | null;
  },
): Promise<AppError | null> {
  const elsewhere = await tx.attachment.findFirst({
    where: {
      id: { in: [...input.missingIds] },
      workspaceId: input.workspaceId,
      conversationId: { not: input.conversationId },
      messageId: null,
      ...input.uploader,
    },
    select: { id: true, conversation: { select: TARGET_CONVERSATION_SELECT } },
  });
  if (!elsewhere) return null;
  if (!input.agentId)
    return new AppError("ATTACHMENT_IN_OTHER_CONVERSATION", {
      details: { attachmentId: elsewhere.id },
    });
  const here = await tx.conversation.findUniqueOrThrow({
    where: { id: input.conversationId },
    select: TARGET_CONVERSATION_SELECT,
  });
  const targetOf = await directTargets(tx, input.workspaceId, input.agentId, [
    elsewhere.conversation,
    here,
  ]);
  const uploadedTo = conversationTarget(elsewhere.conversation, targetOf);
  const uploadTo = conversationTarget(here, targetOf);
  return new AppError("ATTACHMENT_IN_OTHER_CONVERSATION", {
    details: { attachmentId: elsewhere.id, uploadedTo, uploadTo },
    hint: `attachment ${elsewhere.id} was uploaded to ${uploadedTo}; upload it again with --target '${uploadTo}'`,
  });
}
