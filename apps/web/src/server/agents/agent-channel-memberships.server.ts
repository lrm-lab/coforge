import type { PrismaClient } from "#src/generated/prisma/client";
import { isMutedLevel } from "#src/server/conversations/notification-level.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  channelListMembers,
  type ChannelListMember,
} from "#src/server/conversations/channel-list-preview.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { assertAgentChatReadable } from "./agent-chat-access.server";

export type AgentChannelRow = {
  id: string;
  name: string;
  description: string;
  /** Whether the Agent's own membership is muted. */
  muted: boolean;
  /** The channel's group avatar (Frank, 11-10: a channel is never a `#`, task #55). */
  members: ChannelListMember[];
};

/**
 * The open channels `agentId` is an active member of, by name, for its profile's Chat tab. Read
 * only: `assertAgentChatReadable` decides who may ask, and the list holds only the channels the
 * asking person may read too (`visibleChannelWhere`), so a private channel they are not in, an
 * archived channel and one hidden from the Workspace are left out.
 */
export async function listAgentChannels(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string; userId: string },
): Promise<AgentChannelRow[]> {
  const { workspaceId, agentId } = input;
  await assertAgentChatReadable(db, input);
  const channels = await db.conversation.findMany({
    where: {
      ...visibleChannelWhere(workspaceId, { userId: input.userId }),
      archivedAt: null,
      members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
    },
    orderBy: { channelName: "asc" },
    select: {
      id: true,
      channelName: true,
      description: true,
      members: {
        where: { agentId, ...ACTIVE_MEMBER_WHERE },
        select: { notificationLevel: true },
        take: 1,
      },
    },
  });
  // Every row's group avatar in one read with the list, not one per row.
  const members = await channelListMembers(
    db,
    workspaceId,
    channels.map(({ id }) => id),
  );
  return channels.map((channel) => ({
    id: channel.id,
    name: channel.channelName ?? "",
    description: channel.description,
    muted: isMutedLevel(channel.members[0]?.notificationLevel),
    members: members.get(channel.id) ?? [],
  }));
}
