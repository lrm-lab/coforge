import type { PrismaClient } from "#src/generated/prisma/client";
import { ArtifactOrigins } from "#src/server/artifacts/artifact-origins.server";
import {
  bestEffortMessageNotifier,
  type MessageNotifier,
} from "#src/server/notifications/web-push-composition.server";

export function messageAfterCommit(
  db: PrismaClient,
  notifications: MessageNotifier = bestEffortMessageNotifier(db),
): MessageNotifier {
  return {
    async notifyMessage(messageId) {
      void noteArtifactOrigin(db, messageId);
      return notifications.notifyMessage(messageId);
    },
  };
}

async function noteArtifactOrigin(db: PrismaClient, messageId: string) {
  try {
    const message = await db.message.findUnique({
      where: { id: messageId },
      select: { id: true, workspaceId: true, conversationId: true, body: true, createdAt: true },
    });
    if (!message) return;
    await new ArtifactOrigins(db).noteMessage({
      workspaceId: message.workspaceId,
      conversationId: message.conversationId,
      messageId: message.id,
      body: message.body,
      createdAt: message.createdAt,
    });
  } catch {
    console.warn(JSON.stringify({ event: "artifacts:origin_note_failed", messageId }));
  }
}
