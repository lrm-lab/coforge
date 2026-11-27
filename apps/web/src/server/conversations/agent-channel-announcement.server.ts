import type { PrismaClient } from "#src/generated/prisma/client";
import type { ChannelVisibility } from "#src/features/conversations/channel-visibility";
import { isAppErrorCode } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForActor,
  canDirectMessageAgent,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { agentChannelInfo, type AgentChannelInfo } from "./agent-channel-reads.server";
import {
  AgentChannelManagementError,
  channelAuthorityDeniedError,
  visibilityDeniedError,
} from "./agent-channel-management-error.server";
import { normalizeChannelName, parseChannelTarget } from "./agent-channel-targets.server";
import type { ChannelActor } from "./channel-actor.server";
import { canChangeChannelVisibility, resolveChannelAuthority } from "./channel-authority.server";
import { directConversationIdBetween, visibleChannelWhere } from "./channel-read-access.server";
import {
  commitConversationPinnedArtifact,
  type PinnedNoticeActor,
} from "./conversation-pinned-artifact.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import type { PublicChannels } from "./public-channels.server";

const DM_ANNOUNCEMENT_TARGET = /^(?:dm:)?@([a-z0-9][a-z0-9_-]{0,63})(?:~(human|agent))?$/;

export function parseDmAnnouncementTarget(
  target: string,
): { peer: string; peerKind?: "human" | "agent" } | null {
  const match = DM_ANNOUNCEMENT_TARGET.exec(target);
  if (!match) return null;
  return {
    peer: match[1]!,
    peerKind: match[2] as "human" | "agent" | undefined,
  };
}

export function resolveAnnouncementArtifactId(
  db: PrismaClient,
  announcement: string | null,
): string | null {
  if (announcement === null) return null;
  const parsed = productionArtifacts(db).pinnedSummary.parseReference(announcement);
  if (!parsed) {
    throw new AgentChannelManagementError(
      400,
      "The announcement must be an Artifact's id or link, not a title. Nothing was changed.",
      "channel_announcement_ref_invalid",
    );
  }
  return parsed;
}

function pinnedArtifactNotInConversationError(channelLabel: string): AgentChannelManagementError {
  return new AgentChannelManagementError(
    404,
    `Artifact not found in ${channelLabel}. Only an Artifact homed in that conversation can be pinned there.`,
    "pinned_artifact_not_in_conversation",
  );
}

async function resolveNoticeActor(
  db: PrismaClient,
  workspaceId: string,
  conversationId: string,
  actor: ChannelActor,
): Promise<{
  noticeActor: PinnedNoticeActor;
  pinnedByUserId: string | null;
  pinnedByAgentId: string | null;
}> {
  if ("userId" in actor) {
    const [member, user] = await Promise.all([
      db.conversationMember.findFirst({
        where: { conversationId, userId: actor.userId, ...ACTIVE_MEMBER_WHERE },
        select: { id: true },
      }),
      db.user.findUnique({
        where: { id: actor.userId },
        select: { username: true, displayName: true },
      }),
    ]);
    return {
      noticeActor: {
        memberId: member?.id ?? null,
        kind: "user",
        handle: user?.username ?? actor.userId,
        displayName: user ? humanLabel(user) : actor.userId,
      },
      pinnedByUserId: actor.userId,
      pinnedByAgentId: null,
    };
  }
  const [member, agent] = await Promise.all([
    db.conversationMember.findFirst({
      where: { conversationId, agentId: actor.agentId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    }),
    db.agent.findUnique({
      where: { id_workspaceId: { id: actor.agentId, workspaceId } },
      select: { name: true, displayName: true },
    }),
  ]);
  return {
    noticeActor: {
      memberId: member?.id ?? null,
      kind: "agent",
      handle: agent?.name ?? actor.agentId,
      displayName: agent?.displayName?.trim() || agent?.name || actor.agentId,
    },
    pinnedByUserId: null,
    pinnedByAgentId: actor.agentId,
  };
}

export async function applyChannelAnnouncement(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  input: {
    workspaceId: string;
    conversationId: string;
    channelLabel: string;
    isDm: boolean;
    actor: ChannelActor;
    artifactId: string | null;
    knownPinnedArtifactId?: string | null;
    preloadedTarget?: { title: string } | null;
  },
): Promise<void> {
  const { noticeActor, pinnedByUserId, pinnedByAgentId } = await resolveNoticeActor(
    db,
    input.workspaceId,
    input.conversationId,
    input.actor,
  );
  try {
    await commitConversationPinnedArtifact(db, realtime, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      isDm: input.isDm,
      actor: noticeActor,
      pinnedByUserId,
      pinnedByAgentId,
      artifactId: input.artifactId,
      knownPinnedArtifactId: input.knownPinnedArtifactId,
      preloadedTarget: input.preloadedTarget,
    });
  } catch (error) {
    if (isAppErrorCode(error, "NOT_FOUND")) {
      throw pinnedArtifactNotInConversationError(input.channelLabel);
    }
    throw error;
  }
}

export async function updateDmAnnouncement(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  input: {
    workspaceId: string;
    actor: ChannelActor;
    target: string;
    peer: string;
    peerKind?: "human" | "agent";
    announcement: string | null;
  },
): Promise<AgentChannelInfo> {
  const [user, agent, viewer] = await Promise.all([
    input.peerKind === "agent"
      ? null
      : db.user.findFirst({
          where: {
            username: input.peer,
            memberships: { some: { workspaceId: input.workspaceId } },
          },
          select: { id: true },
        }),
    input.peerKind === "human"
      ? null
      : db.agent.findFirst({
          where: {
            workspaceId: input.workspaceId,
            name: input.peer,
            systemKind: null,
            ...ACTIVE_AGENT_WHERE,
          },
          select: { id: true, ownerId: true, visibility: true, systemKind: true },
        }),
    input.peerKind === "human"
      ? null
      : agentVisibilityViewerForActor(db, input.workspaceId, input.actor),
  ]);
  const otherUser =
    user && (!("userId" in input.actor) || user.id !== input.actor.userId) ? user : null;
  const visibleAgent =
    agent &&
    (!("agentId" in input.actor) || agent.id !== input.actor.agentId) &&
    ("userId" in input.actor
      ? canDirectMessageAgent(input.actor.userId, agent)
      : viewer !== null && canSeeAgent(viewer, agent))
      ? agent
      : null;
  if (otherUser && visibleAgent) {
    throw new AgentChannelManagementError(
      400,
      `@${input.peer} is a person and an Agent: name @${input.peer}~human or @${input.peer}~agent`,
      "ambiguous_target",
    );
  }
  const peerMember = otherUser
    ? { userId: otherUser.id }
    : visibleAgent
      ? { agentId: visibleAgent.id }
      : null;
  const conversationId = peerMember
    ? await directConversationIdBetween(db, input.workspaceId, input.actor, peerMember)
    : undefined;
  if (!conversationId) {
    throw new AgentChannelManagementError(404, "channel not found");
  }
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      archivedAt: true,
      hiddenFromWorkspaceAt: true,
      kind: true,
      pinnedArtifact: { select: { artifactId: true } },
    },
  });
  if (!conversation || conversation.hiddenFromWorkspaceAt !== null || conversation.kind !== null) {
    throw new AgentChannelManagementError(404, "channel not found");
  }
  if (conversation.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");

  const artifactId = resolveAnnouncementArtifactId(db, input.announcement);

  await applyChannelAnnouncement(db, realtime, {
    workspaceId: input.workspaceId,
    conversationId: conversation.id,
    channelLabel: input.target,
    isDm: true,
    actor: input.actor,
    artifactId,
    knownPinnedArtifactId: conversation.pinnedArtifact?.artifactId ?? null,
  });

  const [summaries, agentsCount, humansCount] = await Promise.all([
    artifactId
      ? productionArtifacts(db).pinnedSummary.readSummariesForConversations(input.workspaceId, [
          { conversationId: conversation.id, artifactId },
        ])
      : Promise.resolve(new Map()),
    db.conversationMember.count({
      where: { conversationId: conversation.id, agentId: { not: null }, ...ACTIVE_MEMBER_WHERE },
    }),
    db.conversationMember.count({
      where: { conversationId: conversation.id, userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
    }),
  ]);

  return {
    id: conversation.id,
    name: input.target,
    description: "",
    visibility: "private",
    archived: false,
    joined: true,
    muted: false,
    memberCounts: { agents: agentsCount, humans: humansCount },
    channelCapabilities: {
      post: true,
      leave: false,
      add_member: false,
      update: true,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
    },
    announcement: summaries.get(conversation.id) ?? null,
  };
}

export async function updateAgentChannel(
  ports: { db: PrismaClient; channels: PublicChannels; realtime?: ConversationRealtime },
  workspaceId: string,
  actor: ChannelActor,
  target: string,
  patch: {
    name?: string;
    description?: string;
    visibility?: ChannelVisibility;
    announcement?: string | null;
  },
): Promise<AgentChannelInfo> {
  const changesInfo = patch.name !== undefined || patch.description !== undefined;
  const changesAnnouncement = patch.announcement !== undefined;
  if (!changesInfo && patch.visibility === undefined && !changesAnnouncement)
    throw new AgentChannelManagementError(
      400,
      "update requires --name, --description, --public, --private, --announcement or --no-announcement",
    );
  const dmTarget = parseDmAnnouncementTarget(target);
  if (dmTarget) {
    if (changesInfo || patch.visibility !== undefined)
      throw new AgentChannelManagementError(
        400,
        "A DM has no name, description or visibility to change; only its pinned content can be set or removed.",
      );
    return updateDmAnnouncement(ports.db, ports.realtime, {
      workspaceId,
      actor,
      target,
      peer: dmTarget.peer,
      peerKind: dmTarget.peerKind,
      announcement: patch.announcement ?? null,
    });
  }
  const channelName = parseChannelTarget(target);
  const channel = await ports.db.conversation.findFirst({
    where: { ...visibleChannelWhere(workspaceId, actor), channelName },
    include: { pinnedArtifact: { select: { artifactId: true } } },
  });
  if (!channel) throw new AgentChannelManagementError(404, "channel not found");
  const authority = await resolveChannelAuthority(ports.db, workspaceId, actor, channel);
  if ((changesInfo || changesAnnouncement) && authority.adminBasis === undefined)
    throw channelAuthorityDeniedError("update");
  if (patch.visibility !== undefined) {
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "#general is always public");
    if (!canChangeChannelVisibility(channelName, authority.serverRole, authority.isActiveMember))
      throw visibilityDeniedError();
  }
  if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
  const announcementArtifactId = changesAnnouncement
    ? resolveAnnouncementArtifactId(ports.db, patch.announcement ?? null)
    : undefined;
  let preloadedAnnouncementTarget: { title: string } | null | undefined;
  if (announcementArtifactId) {
    preloadedAnnouncementTarget = await productionArtifacts(
      ports.db,
    ).pinnedSummary.verifyHomedInConversation({
      workspaceId,
      conversationId: channel.id,
      artifactId: announcementArtifactId,
    });
    if (!preloadedAnnouncementTarget) {
      throw pinnedArtifactNotInConversationError(`#${channelName}`);
    }
  }
  let nextName: string | undefined;
  if (patch.name !== undefined) {
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot rename #general");
    nextName = normalizeChannelName(patch.name);
    if (nextName === "general") throw new AgentChannelManagementError(409, "general is reserved");
  }
  if (changesInfo)
    try {
      await ports.channels.updateInfo(workspaceId, actor, channel.id, {
        name: nextName,
        description: patch.description,
      });
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw channelAuthorityDeniedError("update");
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
  if (patch.visibility !== undefined)
    try {
      await ports.channels.setVisibility(workspaceId, actor, channel.id, patch.visibility);
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw visibilityDeniedError();
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel is archived");
      if (isAppErrorCode(error, "NOT_FOUND"))
        throw new AgentChannelManagementError(404, "channel not found");
      throw error;
    }
  if (changesAnnouncement)
    await applyChannelAnnouncement(ports.db, ports.realtime, {
      workspaceId,
      conversationId: channel.id,
      channelLabel: `#${nextName ?? channelName}`,
      isDm: false,
      actor,
      artifactId: announcementArtifactId ?? null,
      knownPinnedArtifactId: channel.pinnedArtifact?.artifactId ?? null,
      preloadedTarget: preloadedAnnouncementTarget,
    });
  const refreshed = await ports.db.conversation.findFirst({
    where: { ...visibleChannelWhere(workspaceId, actor), channelName: nextName ?? channelName },
  });
  if (!refreshed) throw new AgentChannelManagementError(404, "channel not found");
  return agentChannelInfo(ports.db, workspaceId, refreshed, actor);
}
