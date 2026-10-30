import type { PrismaClient } from "#src/generated/prisma/client";
import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import { attachActionCardViews } from "./action-card-attach.server";
import type { ActionCardView } from "./action-card-view.server";
import { attachForwardedAccess } from "./message-forward-view.server";

/**
 * Settles what a browser message page shows per viewer, each in one batched lookup for the whole
 * page: the action card's state and who may act on it, and whether a forward's original is open
 * to them. Every page-shaped read of `mapBrowserMessage` rows ends in this.
 */
export async function attachViewerViews<T extends { id: string; forwarded?: ForwardedMessageView }>(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
): Promise<(T & { actionCard?: ActionCardView })[]> {
  const [settled, withCards] = await Promise.all([
    attachForwardedAccess(db, workspaceId, viewerUserId, messages),
    attachActionCardViews(db, workspaceId, viewerUserId, messages),
  ]);
  // Both keep the page's order, one message each.
  return settled.map((message, index) => {
    const actionCard = withCards[index]!.actionCard;
    return actionCard ? { ...message, actionCard } : message;
  });
}
