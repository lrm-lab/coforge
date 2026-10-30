import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
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
 * it is a Workspace assistant, otherwise as itself, a public Agent of the Workspace. */
export async function createAgentChannel(
  { db, channels, realtime }: AgentChannelCreatePorts,
  workspaceId: string,
  agentId: string,
  rawName: string,
  description: string | undefined,
) {
  const delegated = await workspaceAssistantUser(db, workspaceId, agentId);
  if (delegated) {
    const name = normalizeChannelName(rawName);
    const created = await channels.create(
      workspaceId,
      delegated.userId,
      name,
      undefined,
      description,
    );
    return {
      target: `#${name}`,
      channel: { id: created.id, name: `#${name}`, description: description ?? "" },
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
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new AgentChannelManagementError(409, "channel name is already in use");
    throw error;
  }
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
