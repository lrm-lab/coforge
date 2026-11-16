import { REMEMBERED_DELIVERIES } from "./agent-message-attention-index-helpers";

/** What a generation remembers about the deliveries it has already handled. */
export type GenerationMemory = {
  seenDeliveryIds: Set<string>;
  seenMessageIds: Set<string>;
  notified: Set<string>;
  notificationAttempts: Map<string, Promise<void>>;
};

/**
 * Records one delivery in the generation's ring, dropping the oldest when it is full. Every set is
 * bounded by `REMEMBERED_DELIVERIES`, so a long-lived generation cannot grow without limit.
 */
export function rememberDelivery(
  generation: GenerationMemory,
  deliveryId: string,
  messageId?: string,
): void {
  if (generation.seenDeliveryIds.size >= REMEMBERED_DELIVERIES) {
    const oldest = generation.seenDeliveryIds.values().next().value!;
    generation.seenDeliveryIds.delete(oldest);
    generation.notified.delete(oldest);
    generation.notificationAttempts.delete(oldest);
  }
  generation.seenDeliveryIds.add(deliveryId);
  if (messageId === undefined) return;
  if (generation.seenMessageIds.size >= REMEMBERED_DELIVERIES)
    generation.seenMessageIds.delete(generation.seenMessageIds.values().next().value!);
  generation.seenMessageIds.add(messageId);
}
