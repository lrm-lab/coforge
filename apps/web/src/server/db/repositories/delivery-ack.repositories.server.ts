import type { PrismaClient } from "#src/generated/prisma/client";
import {
  TRACKED_MENTION_STATE_SELECT,
  type TrackedMentionState,
} from "./mention-delivery.repositories.server";

/** Marks one delivery received by the Computer that holds its Agent, and returns the delivery's
 * tracked-mention state from the same write, so an untracked ACK needs nothing more. */
export async function receiveDeliveryAck(
  db: Pick<PrismaClient, "agentMessageDelivery">,
  input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    deliveryId: string;
    messageId: string;
    sequence: number;
  },
) {
  const acked = await db.agentMessageDelivery.updateManyAndReturn({
    where: {
      deliveryId: input.deliveryId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      messageId: input.messageId,
      sequence: input.sequence,
      agent: { computerId: input.computerId },
    },
    data: { receivedAt: new Date() },
    select: TRACKED_MENTION_STATE_SELECT,
  });
  if (acked.length !== 1) throw new Error("delivery acknowledgement is not authorized");
  // The migration's CHECK constraints hold these columns to their closed sets.
  return acked[0] as TrackedMentionState;
}
