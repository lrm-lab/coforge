import type { PrismaClient } from "#src/generated/prisma/client";
import {
  ACTIVE_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { assertAgentChatReadable } from "./agent-chat-access.server";

export type AgentChannelRow = {
  id: string;
  name: string;
  description: string;
  /** Whether the Agent's own membership is muted. */
  muted: boolean;
};

/**
 * The open channels `agentId` is an active member of, by name, for its profile's Chat tab. Read
 * only: `assertAgentChatReadable` decides who may ask. An archived channel and one hidden from the
 * Workspace are left out.
 */
export async function listAgentChannels(
  db: Pick<PrismaClient, "agent" | "workspaceMembership" | "conversation">,
  input: { workspaceId: string; agentId: string; userId: string },
): Promise<AgentChannelRow[]> {
  const { workspaceId, agentId } = input;
  await assertAgentChatReadable(db, input);
  const channels = await db.conversation.findMany({
    where: {
      workspaceId,
      channelName: { not: null },
      archivedAt: null,
      ...VISIBLE_CONVERSATION_WHERE,
      members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
    },
    orderBy: { channelName: "asc" },
    select: {
      id: true,
      channelName: true,
      description: true,
      members: {
        where: { agentId, ...ACTIVE_MEMBER_WHERE },
        select: { channelMuted: true },
        take: 1,
      },
    },
  });
  return channels.map((channel) => ({
    id: channel.id,
    name: channel.channelName ?? "",
    description: channel.description,
    muted: channel.members[0]?.channelMuted ?? false,
  }));
}
