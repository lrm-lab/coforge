import type { Conversation, PrismaClient } from "#src/generated/prisma/client";
import { resolveAgentChannelStatuses } from "#src/server/agents/agent-channel-status.server";
import { getAgentDisplay, type AgentDisplay } from "#src/server/agents/agent-display.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import type { ChannelActor } from "./channel-actor.server";
import {
  resolveChannelAuthority,
  type ChannelAdminBasis,
  type ChannelCapabilities,
} from "./channel-authority.server";
import {
  channelVisibilityOf,
  type ChannelVisibility,
} from "#src/features/conversations/channel-visibility";

// What an Agent reads about a channel or a direct message through `AgentChannelManagement`: its
// info and its roster with each Agent's live status.

type AgentDisplayPort = Pick<AgentDisplay, "snapshot" | "snapshotMany">;

export type AgentChannelInfo = {
  id: string;
  name: string;
  description: string;
  /** Who may read it (`CHANNEL_VISIBILITY`). */
  visibility: ChannelVisibility;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
  /**
   * Stored channelRole, present only for an active acting member.
   */
  channelRole?: string;
  /** Present only when the acting Agent has channel-admin authority on this channel — either
   * basis. */
  channelAdminBasis?: ChannelAdminBasis;
  /** Every capability name; only the ones this Agent may currently invoke are `true`. */
  channelCapabilities: ChannelCapabilities;
  /**
   * A Project discussion group owned by this Workspace; fields match workspace info --projects.
   */
  project?: {
    id: string;
    name: string;
    slug: string;
    githubFullName?: string;
    githubHtmlUrl?: string;
  };
};

export type AgentChannelRoster = {
  target: string;
  // Channel roles apply to active #channel members; @user DM rosters omit them.
  agents: Array<{
    name: string;
    displayName: string;
    description: string;
    serverRole: string;
    channelRole?: string;
    channelAdminBasis?: ChannelAdminBasis;
    self: boolean;
    status: "online" | "offline" | "unknown";
    activity?: string;
    activityDetail?: string;
  }>;
  humans: Array<{
    username: string;
    serverRole: string;
    channelRole?: string;
    channelAdminBasis?: ChannelAdminBasis;
  }>;
};

/** What `channel info` shows an Agent (or the Workspace assistant acting for a person) about a
 * channel. */
export async function agentChannelInfo(
  db: PrismaClient,
  workspaceId: string,
  channel: Pick<
    Conversation,
    "id" | "channelName" | "description" | "archivedAt" | "projectId" | "visibility"
  >,
  actor: ChannelActor,
): Promise<AgentChannelInfo> {
  const [member, memberCounts, authority, project] = await Promise.all([
    db.conversationMember.findFirst({
      where: { conversationId: channel.id, ...actor, ...ACTIVE_MEMBER_WHERE },
      select: { channelMuted: true },
    }),
    countActiveMembers(db, channel.id),
    resolveChannelAuthority(db, workspaceId, actor, channel),
    channelProject(db, workspaceId, channel.projectId),
  ]);
  return {
    id: channel.id,
    name: `#${channel.channelName}`,
    description: channel.description,
    visibility: channelVisibilityOf(channel),
    archived: channel.archivedAt !== null,
    joined: Boolean(member),
    muted: member?.channelMuted ?? false,
    memberCounts,
    channelRole: authority.channelRole,
    channelAdminBasis: authority.adminBasis,
    channelCapabilities: authority.capabilities,
    ...(project ? { project } : {}),
  };
}

/**
 * Resolve the bound Project only in this Workspace, even if a corrupt projectId crosses Workspaces.
 */
async function channelProject(
  db: PrismaClient,
  workspaceId: string,
  projectId: string | null,
): Promise<AgentChannelInfo["project"]> {
  if (!projectId) return undefined;
  const project = await db.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true, name: true, slug: true, githubFullName: true, githubHtmlUrl: true },
  });
  if (!project) return undefined;
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    ...(project.githubFullName ? { githubFullName: project.githubFullName } : {}),
    ...(project.githubHtmlUrl ? { githubHtmlUrl: project.githubHtmlUrl } : {}),
  };
}

async function countActiveMembers(db: PrismaClient, conversationId: string) {
  const [agents, humans] = await Promise.all([
    db.conversationMember.count({
      where: { conversationId, agentId: { not: null }, ...ACTIVE_MEMBER_WHERE },
    }),
    db.conversationMember.count({
      where: { conversationId, userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
    }),
  ]);
  return { agents, humans };
}

/**
 * DM roster: query directly because PublicChannels.members requires a named channel.
 */
export async function directConversationRoster(
  db: PrismaClient,
  display: AgentDisplayPort | undefined,
  workspaceId: string,
  conversationId: string,
  callingAgentId: string,
  target: string,
): Promise<AgentChannelRoster> {
  const rows = await db.conversationMember.findMany({
    where: { conversationId, ...ACTIVE_MEMBER_WHERE },
    select: {
      agentId: true,
      userId: true,
      agent: {
        select: {
          id: true,
          name: true,
          displayName: true,
          description: true,
          role: true,
          computerId: true,
        },
      },
      user: { select: { id: true, username: true } },
    },
  });
  const agentRows = rows.flatMap((row) => (row.agent ? [row.agent] : []));
  const humanRows = rows.flatMap((row) => (row.user ? [row.user] : []));
  const roles = humanRows.length
    ? await db.workspaceMembership.findMany({
        where: { workspaceId, userId: { in: humanRows.map((row) => row.id) } },
        select: { userId: true, role: true },
      })
    : [];
  const roleByUserId = new Map(roles.map((role) => [role.userId, role.role]));
  // DM entries omit channelRole/channelAdminBasis.
  return shapeAgentRoster(display, workspaceId, callingAgentId, target, {
    agents: agentRows.map((agent) => ({ ...agent, serverRole: agent.role })),
    humans: humanRows.map((row) => ({
      id: row.id,
      username: row.username,
      serverRole: roleByUserId.get(row.id) ?? "member",
    })),
  });
}

/**
 * Shape shared channel/DM membership facts for the Agent: add self and live status/activity
 * via resolveAgentChannelStatuses; keep membership, roles and authority in shared data.
 */
export async function shapeAgentRoster(
  display: AgentDisplayPort | undefined,
  workspaceId: string,
  callingAgentId: string,
  target: string,
  raw: {
    agents: Array<{
      id: string;
      name: string;
      displayName: string;
      description: string;
      serverRole: string;
      channelRole?: string;
      channelAdminBasis?: ChannelAdminBasis;
      computerId: string | null;
    }>;
    humans: Array<{
      id: string;
      username: string;
      serverRole: string;
      channelRole?: string;
      channelAdminBasis?: ChannelAdminBasis;
    }>;
  },
): Promise<AgentChannelRoster> {
  const statuses = await resolveAgentChannelStatuses(
    resolvedDisplay(display),
    raw.agents.map((agent) => ({ workspaceId, computerId: agent.computerId, agentId: agent.id })),
  );
  const agents = raw.agents.map((agent, index) => ({
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    serverRole: agent.serverRole,
    channelRole: agent.channelRole,
    channelAdminBasis: agent.channelAdminBasis,
    self: agent.id === callingAgentId,
    ...statuses[index],
  }));
  return {
    target,
    agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
    humans: raw.humans
      .map((human) => ({
        username: human.username,
        serverRole: human.serverRole,
        channelRole: human.channelRole,
        channelAdminBasis: human.channelAdminBasis,
      }))
      .sort((left, right) => left.username.localeCompare(right.username)),
  };
}

/**
 * Construct AgentDisplay lazily so missing Redis becomes per-Agent unknown status, not a failed roster.
 */
function resolvedDisplay(display: AgentDisplayPort | undefined): AgentDisplayPort {
  return (
    display ?? {
      snapshot: (scope) => getAgentDisplay().snapshot(scope),
      snapshotMany: (scopes) => getAgentDisplay().snapshotMany(scopes),
    }
  );
}
