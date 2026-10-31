import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentDeliveryPublisher } from "#src/server/conversations/agent-delivery.server";
import { announceNotifiedPeople } from "#src/server/conversations/pending-mention-actions.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { agentMessageSender } from "#src/server/conversations/sender-display.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { AttachmentCommentNotices } from "./attachment-comments.server";

/**
 * The post-commit wake for a posted attachment comment (`AttachmentCommentNotices`): each
 * notified person gets an `activityChanged` so their inbox re-reads, and each Agent recipient's
 * delivery is pushed to its daemon on the control channel, addressed `attachment:<id>` (a reply
 * names its root: `attachment:<id>:<root>`). Best effort — a missed push stays unreceived and the
 * daemon's recovery replays it, exactly like a mention delivery.
 */
export function attachmentCommentNotices(
  db: PrismaClient,
  api: CentrifugoServerApi,
  realtime?: Pick<ConversationRealtime, "activityChanged">,
): AttachmentCommentNotices {
  return {
    async publish(posted) {
      const deliveries = posted.notified.deliveries;
      if (deliveries.length) {
        const rows = await db.agentMessageDelivery.findMany({
          where: {
            deliveryId: { in: deliveries.map((delivery) => delivery.deliveryId) },
            workspaceId: posted.notified.workspaceId,
          },
          select: {
            deliveryId: true,
            agentId: true,
            sequence: true,
            reason: true,
            agent: { select: { computerId: true } },
            message: {
              select: {
                id: true,
                conversationId: true,
                threadRootId: true,
                createdAt: true,
                body: true,
                mentions: MESSAGE_MENTIONS_SELECT,
                attachmentComment: { select: { attachmentId: true } },
                conversation: {
                  select: { attachmentCommentThread: { select: { attachmentId: true } } },
                },
                sender: {
                  select: {
                    agentId: true,
                    agent: { select: { name: true, description: true } },
                    user: { select: { username: true, description: true } },
                  },
                },
              },
            },
          },
        });
        await new AgentDeliveryPublisher(api).publish(
          posted.notified.workspaceId,
          rows.flatMap((row) => {
            const attachmentId = row.message.attachmentComment?.attachmentId;
            if (!attachmentId) return [];
            const sender = agentMessageSender(row.message.sender);
            const mentioned = row.reason === "mentioned";
            return [
              {
                computerId: row.agent.computerId,
                requestId: row.deliveryId,
                conversationId: row.message.conversationId,
                agentId: row.agentId,
                messageId: row.message.id,
                deliveryId: row.deliveryId,
                sequence: row.sequence,
                createdAtMs: row.message.createdAt.getTime(),
                body: row.message.body,
                mentions: row.message.mentions,
                target: `attachment:${attachmentId}${
                  row.message.threadRootId && row.message.conversation.attachmentCommentThread
                    ? `:${row.message.threadRootId}`
                    : ""
                }`,
                latestSenderKind: sender.kind,
                latestSenderHandle: sender.handle,
                latestSenderDescription: sender.description,
                mentionsAgent: mentioned,
                ...(row.reason ? { reason: row.reason } : {}),
              },
            ];
          }),
        );
      }
      await announceNotifiedPeople(
        realtime ?? new CentrifugoConversationRealtime(api),
        posted.notified.workspaceId,
        posted.notified.userIds,
      );
    },
  };
}
