import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { personConversationAccess } from "./channel-read-access.server";

/** Generic subscriptions require a channel or DM the viewer reads (`personConversationAccess`); a
 * private channel they are not in is refused like any other. */
export async function authorizeConversationRealtime(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; conversationId: string },
) {
  const access = await personConversationAccess(db, input.userId, {
    id: input.conversationId,
    workspaceId: input.workspaceId,
  });
  if (access !== "read") throw new AppError("ACCESS_DENIED");
  return input.conversationId;
}
