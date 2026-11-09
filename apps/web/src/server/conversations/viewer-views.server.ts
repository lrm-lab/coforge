import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { ArtifactMessageCard } from "#src/server/artifacts/artifact-composition.server";
import { artifactMessageCards } from "#src/server/artifacts/artifact-composition.server";
import { attachActionCardViews } from "./action-card-attach.server";
import type { ActionCardView } from "./action-card-view.server";
import { attachForwardedAccess } from "./message-forward-view.server";

/**
 * Settles what a browser message page shows per viewer, each in one batched lookup for the whole
 * page: the action card's state and who may act on it, and whether a forward's original is open
 * to them. Every page-shaped read of `mapBrowserMessage` rows ends in this.
 */
export async function attachViewerViews<
  T extends { id: string; body: string; forwarded?: ForwardedMessageView[] },
>(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
): Promise<(T & { actionCard?: ActionCardView; artifactCards?: ArtifactMessageCard[] })[]> {
  const [settled, withCards] = await Promise.all([
    attachForwardedAccess(db, workspaceId, viewerUserId, messages),
    attachActionCardViews(db, workspaceId, viewerUserId, messages),
  ]);
  const artifacts = await artifactMessageCards(db, {
    workspaceId,
    reader: { userId: viewerUserId },
    messages,
  });
  // Both keep the page's order, one message each.
  return settled.map((message, index) => {
    const actionCard = withCards[index]!.actionCard;
    return {
      ...message,
      ...(actionCard ? { actionCard } : {}),
      ...(artifacts[index]?.length ? { artifactCards: artifacts[index] } : {}),
    };
  });
}
