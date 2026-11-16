import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  CHANNEL_VISIBILITY,
  channelVisibilityOf,
  type ChannelVisibility,
} from "#src/features/conversations/channel-visibility";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { AgentChannelManagementError } from "./agent-channel-management-error.server";
import { normalizeChannelName } from "./agent-channel-targets.server";
import { createChannel } from "./channel-creation.server";
import {
  announceChannelCreated,
  channelInfoOf,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import { channelAudience } from "./conversation-signal-scope.server";
import type { PublicChannels } from "./public-channels.server";
export type AgentChannelCreatePorts = {
  db: PrismaClient;
  channels: PublicChannels;
  realtime?: ConversationRealtime;
};
export async function createAgentChannel(
  { db, channels, realtime }: AgentChannelCreatePorts,
  workspaceId: string,
  agentId: string,
  rawName: string,
  {
    description,
    visibility,
  }: {
    description?: string;
    visibility?: ChannelVisibility;
  } = {},
) {
  const delegated = await workspaceAssistantUser(db, workspaceId, agentId);
  if (delegated) {
    const name = normalizeChannelName(rawName);
    const created = await channels.create(workspaceId, delegated.userId, name, {
      description,
      visibility,
    });
    return {
      target: `#${name}`,
      channel: {
        id: created.id,
        name: `#${name}`,
        description: description ?? "",
        visibility: visibility ?? CHANNEL_VISIBILITY.PUBLIC,
      },
    };
  }
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, ownerId: true },
  });
  if (!agent)
    throw new AgentChannelManagementError(403, "this Agent does not belong to the Workspace");
  await assertCallerNotPrivate(db, workspaceId, agentId, "create");
  const name = normalizeChannelName(rawName);
  if (name === "general") throw new AgentChannelManagementError(409, "general is reserved");
  let channel: {
    id: string;
    channelName: string | null;
    description: string;
    archivedAt: Date | null;
    visibility: string;
  };
  try {
    channel = await createChannel(db, {
      workspaceId,
      name,
      creator: { agentId },
      description: description ?? "",
      ...(visibility ? { visibility } : {}),
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new AgentChannelManagementError(409, "channel name is already in use");
    throw error;
  }
  await announceChannelCreated(realtime, {
    workspaceId,
    conversationId: channel.id,
    channel: channelInfoOf(channel),
    ...(await channelAudience(db, channel)),
  });
  return {
    target: `#${channel.channelName}`,
    channel: {
      id: channel.id,
      name: `#${channel.channelName}`,
      description: channel.description,
      visibility: channelVisibilityOf(channel),
    },
  };
}
export async function assertCallerNotPrivate(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  operation: "join" | "create",
): Promise<void> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { visibility: true, systemKind: true },
  });
  if (!agent || agent.visibility !== AGENT_VISIBILITY.PUBLIC)
    throw new AgentChannelManagementError(403, `a private Agent cannot ${operation} a channel`);
}
