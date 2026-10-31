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
import { attachDefaultMemoryAgent } from "#src/server/workspace-memory/default-memory-agent.server";
import { isOpenVikingPrototypeEnabled } from "#src/server/workspace-memory/prototype-gate";
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

/** What `createAgentChannel` writes through: `AgentChannelManagement`'s own ports. */
export type AgentChannelCreatePorts = {
  db: PrismaClient;
  channels: PublicChannels;
  realtime?: ConversationRealtime;
};

/** `channel create` for an Agent (`AgentChannelManagement.create`): as the person it acts for when
 * it is a Workspace assistant, otherwise as itself, a public Agent of the Workspace. Public unless
 * `visibility` says private (task #302); the answer names the channel's visibility, so a caller
 * talking to a server that knows no private channels sees what it got. */
export async function createAgentChannel(
  { db, channels, realtime }: AgentChannelCreatePorts,
  workspaceId: string,
  agentId: string,
  rawName: string,
  { description, visibility }: { description?: string; visibility?: ChannelVisibility } = {},
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
  // Workspace members may create channels without an admin role.
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
  // Workspace memory is offered to everyone, so its Agent joins a public channel only.
  if (channel.visibility === CHANNEL_VISIBILITY.PUBLIC)
    await attachDefaultMemoryAgent(db, {
      workspaceId,
      conversationId: channel.id,
      actorUserId: agent.ownerId,
      now: new Date(),
      gate: { prototypeEnabled: isOpenVikingPrototypeEnabled(Bun.env) },
    });
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

/** Ordinary private Agents cannot join or create channels; shared by `join` and `create`. */
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
