import type { PrismaClient } from "#src/generated/prisma/client";
import type { ActionCardView } from "./action-card-view.server";
import { actionCardViews, type ActionCardViewsOptions } from "./action-card-views.server";

export async function attachActionCardViews<T extends { id: string }>(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
  options?: ActionCardViewsOptions,
): Promise<(T & { actionCard?: ActionCardView })[]> {
  if (!messages.length) return messages as (T & { actionCard?: ActionCardView })[];
  const views = await actionCardViews(
    db,
    workspaceId,
    viewerUserId,
    messages.map((message) => message.id),
    options,
  );
  if (!views.size) return messages as (T & { actionCard?: ActionCardView })[];
  return messages.map((message) =>
    views.has(message.id) ? { ...message, actionCard: views.get(message.id) } : message,
  );
}
