import type { PrismaClient } from "#src/generated/prisma/client";
import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import {
  recordChannelCreated,
  type ChannelMember,
} from "#src/server/app-notifications/channel-events.server";

/**
 * Writes a new channel with its creator as the first member and admin, and records the creation
 * for the apps installed in the Workspace, in one transaction. A person's creation
 * (`PublicChannels.create`) and an Agent's (`AgentChannelManagement.create`) both come here. A taken
 * name is the caller's unique violation to translate. While no app notification can be recorded
 * it is the single write it always was.
 */
export function createChannel(
  db: PrismaClient,
  input: {
    workspaceId: string;
    name: string;
    creator: ChannelMember;
    projectId?: string;
    description?: string;
  },
) {
  const args = {
    data: {
      workspaceId: input.workspaceId,
      channelName: input.name,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // The creator becomes the channel's first admin.
      members: { create: { ...input.creator, channelRole: "admin" } },
    },
    select: { id: true, channelName: true, description: true, archivedAt: true, visibility: true },
  };
  if (!appNotificationsPossible()) return db.conversation.create(args);
  return db.$transaction(async (tx) => {
    const channel = await tx.conversation.create(args);
    await recordChannelCreated(tx, input.workspaceId, {
      id: channel.id,
      name: input.name,
      creator: input.creator,
    });
    return channel;
  });
}
