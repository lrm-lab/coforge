import type { Prisma } from "#src/generated/prisma/client";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import type { Transaction } from "./task-board-ports.server";
import { discussionOf } from "./task-discussion-store.server";

/** `#channel`, or `dm:@peer` for a task on a direct board. */
export function boardLabel(channelName: string | null, peer?: string | null) {
  return channelName ? `#${channelName}` : `dm:@${peer ?? "?"}`;
}

/**
 * A server notice in a task's conversation (an assignment, a follower leaving): no sender,
 * delivered to `deliverToAgentId` when it names one. The caller holds the board's lock.
 */
export async function postTaskNotice(
  tx: Transaction,
  scope: { conversationId: string; workspaceId: string },
  taskId: string,
  notice: { id?: string; body: string; system?: SystemNotice; deliverToAgentId?: string | null },
) {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { id: true, discussionConversationId: true },
  });
  const conversationId = await discussionOf(tx, task, scope.workspaceId);
  await lockConversation(tx, conversationId);
  const sequence = await allocateSequence(tx, conversationId);
  const message = await tx.message.create({
    data: {
      id: notice.id,
      workspaceId: scope.workspaceId,
      conversationId,
      body: notice.body,
      sequence,
      deliveries: notice.deliverToAgentId
        ? {
            create: [
              {
                workspaceId: scope.workspaceId,
                conversationId,
                agentId: notice.deliverToAgentId,
                sequence,
              },
            ],
          }
        : undefined,
    },
    select: { id: true, sequence: true, conversationId: true, workspaceId: true, body: true },
  });
  if (notice.system)
    await tx.systemMessage.create({
      data: {
        messageId: message.id,
        conversationId,
        workspaceId: scope.workspaceId,
        kind: notice.system.kind,
        params: notice.system.params as Prisma.InputJsonObject,
      },
    });
  return message;
}
