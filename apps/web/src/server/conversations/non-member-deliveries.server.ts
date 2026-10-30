import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  PrismaMentionDeliveryRepository,
  type MentionDeliveryDb,
} from "#src/server/db/repositories/mention-delivery.repositories.server";
import { AGENT_FORWARD_SELECT } from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { AgentDeliveryPublisher, channelTarget } from "./agent-delivery.server";
import { agentForwarded } from "./agent-message-view.server";
import { MentionDeliveryIssuer } from "./mention-deliveries.server";
import { MESSAGE_MENTIONS_SELECT } from "./mentions.server";
import { agentMessageSender } from "./sender-display.server";

/** A notification that must still reach an Agent's daemon, once its delivery row exists. */
export type NonMemberDelivery = { deliveryId: string; agentId: string; messageId: string };

/**
 * Hands each new non-member delivery to its Agent's daemon, as the send path does for a member:
 * the message as the Agent reads it, marked as a personal notification that reached it from
 * outside the channel. Best effort: the delivery row is what counts, and the daemon's recovery
 * replays one it missed.
 */
export async function publishNonMemberDeliveries(
  db: MentionDeliveryDb,
  publisher: Pick<CentrifugoServerApi, "publishBatch">,
  workspaceId: string,
  deliveries: readonly NonMemberDelivery[],
): Promise<void> {
  if (!deliveries.length) return;
  const rows = await db.agentMessageDelivery.findMany({
    where: { deliveryId: { in: deliveries.map((delivery) => delivery.deliveryId) }, workspaceId },
    select: {
      deliveryId: true,
      agentId: true,
      sequence: true,
      agent: { select: { computerId: true } },
      message: {
        select: {
          id: true,
          conversationId: true,
          threadRootId: true,
          createdAt: true,
          body: true,
          mentions: MESSAGE_MENTIONS_SELECT,
          forward: AGENT_FORWARD_SELECT,
          attachments: { orderBy: { position: "asc" }, select: { id: true } },
          conversation: { select: { channelName: true } },
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
  // A notified Agent is personally mentioned, so each notification is a tracked mention. A
  // failed push leaves the delivery unreceived, so the daemon's recovery replays it.
  await new AgentDeliveryPublisher(
    publisher,
    new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(db)),
  ).publish(
    workspaceId,
    rows.map((row) => {
      const sender = agentMessageSender(row.message.sender);
      return {
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
        ...(row.message.forward
          ? { forwarded: agentForwarded(row.message.forward, row.message.attachments) }
          : {}),
        target: `${channelTarget(row.message.conversation.channelName ?? "")}${row.message.threadRootId ? `:${row.message.threadRootId}` : ""}`,
        latestSenderKind: sender.kind,
        latestSenderHandle: sender.handle,
        latestSenderDescription: sender.description,
        mentionsAgent: true,
        nonMemberMention: true,
      };
    }),
  );
}
