import type { Prisma } from "#src/generated/prisma/client";

/**
 * The pending choice cards a person's message answers in chat, marked in the message's own
 * transaction so a failed send leaves them pending.
 *
 * The rule is conservative: only the asked person, only the card's conversation, only their first
 * message after the card, and only in the card's own thread — or, for a top-level card, in that
 * card's thread (a reply to it). A message in another thread does not answer it, and a later
 * message never replaces the first one.
 */
export async function markChoiceCardsAnsweredInChat(
  tx: Pick<Prisma.TransactionClient, "actionCard">,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
    sequence: number;
    threadRootId: string | null;
  },
): Promise<string[]> {
  // A partial transaction client (a send test's fake) has no card model; nothing to answer there.
  if (!tx.actionCard) return [];
  const cards = await tx.actionCard.findMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      kind: "choice",
      state: "pending",
      payload: { path: ["to"], equals: input.userId },
      message: { sequence: { lt: input.sequence } },
    },
    select: { messageId: true, message: { select: { threadRootId: true } } },
  });
  const answered = cards
    .filter((card) => {
      const cardThread = card.message.threadRootId;
      return cardThread === null
        ? input.threadRootId === null || input.threadRootId === card.messageId
        : input.threadRootId === cardThread;
    })
    .map((card) => card.messageId);
  if (answered.length === 0) return [];
  await tx.actionCard.updateMany({
    where: { messageId: { in: answered }, state: "pending" },
    data: {
      state: "answered_in_chat",
      answeredInChatMessageId: input.messageId,
      answeredInChatAt: new Date(),
    },
  });
  return answered;
}
