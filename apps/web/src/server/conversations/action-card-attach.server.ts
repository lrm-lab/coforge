import type { PrismaClient } from "#src/generated/prisma/client";
import { ActionCards } from "./action-cards.server";
import type { ActionCardView } from "./action-card-view.server";

/**
 * Attaches `actionCard` to every message in a page that has one, in one batched
 * `ActionCards.viewsFor` lookup. Shared by the channel and direct-conversation message-page
 * Server Functions so the merge logic lives in exactly one place.
 */
export async function attachActionCardViews<T extends { id: string }>(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
): Promise<(T & { actionCard?: ActionCardView })[]> {
  if (!messages.length) return messages as (T & { actionCard?: ActionCardView })[];
  const views = await new ActionCards(db).viewsFor(
    workspaceId,
    viewerUserId,
    messages.map((message) => message.id),
  );
  if (!views.size) return messages as (T & { actionCard?: ActionCardView })[];
  return messages.map((message) =>
    views.has(message.id) ? { ...message, actionCard: views.get(message.id) } : message,
  );
}
