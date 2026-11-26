import { isCardEvent } from "./agent-message-attention-index-helpers";

/**
 * Whether an ordinary (non-card-event) delivery's sequence is already in the Agent's exact-seen
 * set for that target. Card events reuse the card message's sequence, which the Agent usually
 * already saw when it prepared the card, so they must never be skipped this way.
 */
export function ordinaryDeliveryAlreadySeenExact(
  message: { reason?: string; target?: string; conversationId?: string; sequence: number },
  agentId: string,
  attention: {
    seenExactSequences?: (
      agentId: string,
      target: string,
      conversationId: string,
    ) => readonly number[] | undefined;
  },
): boolean {
  return (
    message.conversationId !== undefined &&
    message.conversationId !== "" &&
    message.target !== undefined &&
    !isCardEvent(message) &&
    (attention
      .seenExactSequences?.(agentId, message.target, message.conversationId)
      ?.includes(message.sequence) ??
      false)
  );
}
