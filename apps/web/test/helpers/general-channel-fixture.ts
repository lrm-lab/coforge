import type { PrismaClient } from "#src/generated/prisma/client";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";

/** Puts the Workspace's people into its #general, as a write point does. */
export function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}
