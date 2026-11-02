import type { PrismaClient } from "#src/generated/prisma/client";
import { readableConversationWhere } from "./channel-read-access.server";

/** One pending choice card the viewer may answer, as the Activity "waiting" list shows it. */
export type WaitingChoiceCard = {
  messageId: string;
  conversationId: string;
  channelName: string | null;
  prompt: string;
  options: { id: string; label: string }[];
  /** The asked person's user id. */
  to: string;
  preparedBy: { agentId: string; name: string };
  createdAt: string;
};

/**
 * The pending choice cards this person may answer, newest first: a card that names them, in a
 * conversation they can read. The card's own commit rule (`payload.to`) is the filter.
 */
export async function waitingChoiceCards(
  db: Pick<PrismaClient, "actionCard">,
  workspaceId: string,
  userId: string,
): Promise<WaitingChoiceCard[]> {
  const cards = await db.actionCard.findMany({
    where: {
      workspaceId,
      kind: "choice",
      state: "pending",
      conversation: readableConversationWhere(workspaceId, { userId }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      messageId: true,
      conversationId: true,
      payload: true,
      createdAt: true,
      conversation: { select: { channelName: true } },
      preparedByAgent: { select: { id: true, name: true } },
    },
  });
  return cards.flatMap((card) => {
    const payload = card.payload as {
      to?: string;
      prompt?: string;
      options?: { id: string; label: string }[];
    };
    if (payload.to !== userId) return [];
    return [
      {
        messageId: card.messageId,
        conversationId: card.conversationId,
        channelName: card.conversation.channelName,
        prompt: payload.prompt ?? "",
        options: payload.options ?? [],
        to: userId,
        preparedBy: { agentId: card.preparedByAgent.id, name: card.preparedByAgent.name },
        createdAt: card.createdAt.toISOString(),
      },
    ];
  });
}
