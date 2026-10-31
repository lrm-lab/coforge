import type { AgentMentionDelivery } from "@lrm/coforge-sdk/agent";
import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import type { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";

/** A message the sending Agent names by its full id or the eight-hex prefix `message read`
 * shows. */
const SENDER_MESSAGE_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`, "i");

export type SenderMentionDeliveries =
  | { state: "found"; messageId: string; deliveries: AgentMentionDelivery[] }
  | { state: "not_found" }
  | { state: "ambiguous" };

type SenderDeliveryRow = Awaited<
  ReturnType<PrismaMentionDeliveryRepository["readSenderDeliveries"]>
>[number]["deliveries"][number];

/** One tracked mention as its sender reads it: labelled with the handle the message wrote (a
 * deleted Agent's name may since have been given to another), and marked when that Agent is
 * deleted. */
function senderDelivery(row: SenderDeliveryRow): AgentMentionDelivery {
  const handle = row.writtenHandle ?? (row.deleted ? undefined : row.currentName);
  if (!handle)
    throw new Error(`tracked mention of deleted Agent ${row.agentId} has no written handle`);
  const target = {
    targetHandle: `@${handle}`,
    ...(row.deleted ? { targetDeleted: true as const } : {}),
  };
  if (row.outcome !== "lost") return { ...target, outcome: row.outcome };
  if (!row.reasonCategory)
    throw new Error(`lost mention of Agent ${row.agentId} has no reason category`);
  return { ...target, outcome: "lost", reasonCategory: row.reasonCategory };
}

/** Mention delivery as the sending Agent reads it: what became of each @mention of an Agent in a
 * message it sent. Any other message is not found, exactly like one that does not exist. */
export class MentionDeliveryLookup {
  constructor(
    private readonly repository: Pick<PrismaMentionDeliveryRepository, "readSenderDeliveries">,
  ) {}

  async forSender(
    scope: { workspaceId: string } & ({ agentId: string } | { userId: string }),
    messageId: string,
  ): Promise<SenderMentionDeliveries> {
    if (!SENDER_MESSAGE_ANCHOR.test(messageId)) return { state: "not_found" };
    const messages =
      "userId" in scope
        ? await this.repository.readSenderDeliveries(
            scope.workspaceId,
            scope.userId,
            messageId,
            "user",
          )
        : await this.repository.readSenderDeliveries(scope.workspaceId, scope.agentId, messageId);
    if (messages.length > 1) return { state: "ambiguous" };
    const [message] = messages;
    if (!message) return { state: "not_found" };
    const deliveries = message.deliveries.map(senderDelivery);
    deliveries.sort((left, right) => left.targetHandle.localeCompare(right.targetHandle));
    return { state: "found", messageId: message.messageId, deliveries };
  }
}
