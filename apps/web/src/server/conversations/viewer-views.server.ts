import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  artifactMessageCards,
  type ArtifactMessageCard,
} from "#src/server/artifacts/artifact-composition.server";
import { attachActionCardViews } from "./action-card-attach.server";
import type { ActionCardView } from "./action-card-view.server";
import { actionCardViews, type ActionCardViewsOptions } from "./action-card-views.server";
import {
  attachmentCommentCounts,
  mapBrowserMessage,
  type BrowserMessageRow,
} from "./browser-message-projection.server";
import { attachForwardedAccess, browserForwarded } from "./message-forward-view.server";
import { systemNoticeFaces } from "./system-notice-people.server";

export type BrowserMessageWithViewerViews = ReturnType<typeof mapBrowserMessage> & {
  actionCard?: ActionCardView;
  artifactCards?: ArtifactMessageCard[];
};

export async function attachViewerViews<
  T extends { id: string; body: string; forwarded?: ForwardedMessageView[] },
>(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
  options?: ActionCardViewsOptions,
): Promise<(T & { actionCard?: ActionCardView; artifactCards?: ArtifactMessageCard[] })[]> {
  if (messages.length === 0) return [];
  const [settled, withCards, artifacts] = await Promise.all([
    attachForwardedAccess(db, workspaceId, viewerUserId, messages),
    attachActionCardViews(db, workspaceId, viewerUserId, messages, options),
    artifactMessageCards(db, {
      workspaceId,
      reader: { userId: viewerUserId },
      messages,
    }),
  ]);
  return settled.map((message, index) => {
    const actionCard = withCards[index]!.actionCard;
    return {
      ...message,
      ...(actionCard ? { actionCard } : {}),
      ...(artifacts[index]?.length ? { artifactCards: artifacts[index] } : {}),
    };
  });
}

export async function mapBrowserMessagesWithViewerViews(
  db: PrismaClient,
  messages: readonly BrowserMessageRow[],
  workspaceId: string,
  viewerUserId: string,
  options?: ActionCardViewsOptions & {
    actionCards?: Promise<Map<string, ActionCardView>>;
  },
): Promise<BrowserMessageWithViewerViews[]> {
  if (messages.length === 0) return [];
  const viewerInputs = messages.map((message) => ({
    id: message.id,
    body: message.body,
    ...(message.forwards?.length
      ? { forwarded: browserForwarded(message.forwards, message.attachments) }
      : {}),
  }));
  const [commentCounts, noticeFaces, settled, cardViews, artifacts] = await Promise.all([
    attachmentCommentCounts(db, messages),
    systemNoticeFaces(db, messages, workspaceId),
    attachForwardedAccess(db, workspaceId, viewerUserId, viewerInputs),
    options?.actionCards ??
      actionCardViews(
        db,
        workspaceId,
        viewerUserId,
        messages.map((message) => message.id),
        options,
      ),
    artifactMessageCards(db, {
      workspaceId,
      reader: { userId: viewerUserId },
      messages: viewerInputs,
    }),
  ]);
  return messages.map((message, index) => {
    const mapped = mapBrowserMessage(message, workspaceId, commentCounts, noticeFaces);
    const forwarded = settled[index]!.forwarded;
    const actionCard = cardViews.get(message.id);
    const artifactCards = artifacts[index];
    return {
      ...mapped,
      ...(forwarded ? { forwarded } : {}),
      ...(actionCard ? { actionCard } : {}),
      ...(artifactCards?.length ? { artifactCards } : {}),
    };
  });
}
