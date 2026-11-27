import type { ChannelAnnouncementSummary } from "@lrm/coforge-sdk/internal";
import type { Conversation, PrismaClient } from "#src/generated/prisma/client";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { isMutedLevel } from "#src/server/conversations/notification-level.server";
import { externalPresenceOf } from "#src/server/agents/agent-user-info.server";
import { externalSetups } from "#src/server/agents/external-agent-presence.server";
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

type AgentDisplayPort = Pick<AgentDisplay, "snapshot" | "snapshotMany">;

export type AgentChannelInfo = {
  id: string;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
  channelRole?: string;
  channelAdminBasis?: ChannelAdminBasis;
  channelCapabilities: ChannelCapabilities;
  announcement: ChannelAnnouncementSummary | null;
};

export type AgentChannelRoster = {
  target: string;
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

export async function agentChannelInfo(
  db: PrismaClient,
  workspaceId: string,
  channel: Pick<Conversation, "id" | "channelName" | "description" | "archivedAt" | "visibility">,
  actor: ChannelActor,
): Promise<AgentChannelInfo> {
  const [member, memberCounts, authority, pinnedRow] = await Promise.all([
    db.conversationMember.findFirst({
      where: { conversationId: channel.id, ...actor, ...ACTIVE_MEMBER_WHERE },
      select: { notificationLevel: true },
    }),
    countActiveMembers(db, channel.id),
    resolveChannelAuthority(db, workspaceId, actor, channel),
    db.conversationPinnedArtifact.findUnique({
      where: { conversationId: channel.id },
      select: { artifactId: true },
    }),
  ]);
  const announcement = pinnedRow
    ? ((
        await productionArtifacts(db).pinnedSummary.readSummariesForConversations(workspaceId, [
          { conversationId: channel.id, artifactId: pinnedRow.artifactId },
        ])
      ).get(channel.id) ?? null)
    : null;
  return {
    id: channel.id,
    name: `#${channel.channelName}`,
    description: channel.description,
    visibility: channelVisibilityOf(channel),
    archived: channel.archivedAt !== null,
    joined: Boolean(member),
    muted: isMutedLevel(member?.notificationLevel),
    memberCounts,
    channelRole: authority.channelRole,
    channelAdminBasis: authority.adminBasis,
    channelCapabilities: authority.capabilities,
    announcement,
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
          hosting: true,
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
  return shapeAgentRoster(
    display,
    workspaceId,
    callingAgentId,
    target,
    {
      agents: agentRows.map((agent) => ({ ...agent, serverRole: agent.role })),
      humans: humanRows.map((row) => ({
        id: row.id,
        username: row.username,
        serverRole: roleByUserId.get(row.id) ?? "member",
      })),
    },
    externalPresenceOf(db),
  );
}

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
      hosting?: string;
    }>;
    humans: Array<{
      id: string;
      username: string;
      serverRole: string;
      channelRole?: string;
      channelAdminBasis?: ChannelAdminBasis;
    }>;
  },
  externalPresence?: Parameters<typeof externalSetups>[0],
): Promise<AgentChannelRoster> {
  const statuses = await resolveAgentChannelStatuses(
    resolvedDisplay(display),
    raw.agents.map((agent) => ({ workspaceId, computerId: agent.computerId, agentId: agent.id })),
    externalPresence
      ? externalSetups(
          externalPresence,
          raw.agents.filter((agent) => agent.hosting === "external").map((agent) => agent.id),
        ).catch(() => undefined)
      : undefined,
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

function resolvedDisplay(display: AgentDisplayPort | undefined): AgentDisplayPort {
  return (
    display ?? {
      snapshot: (scope) => getAgentDisplay().snapshot(scope),
      snapshotMany: (scopes) => getAgentDisplay().snapshotMany(scopes),
    }
  );
}
