import { z } from "zod";
import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

/** One channel named by id, the input most channel server functions extend. */
export const channelInput = z.object({ channelId: z.uuid() });

/** What a channel server function acts with: the channel operations and the signed-in person. */
export function channelScope({ db, workspaceId, user }: WorkspaceUserContext) {
  return {
    channels: new PublicChannels(db),
    db,
    workspaceId,
    userId: user.id,
    username: user.username,
  };
}
