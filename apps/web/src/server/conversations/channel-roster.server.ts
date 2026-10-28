import { AppError, isAppError } from "#src/lib/app-error";
import { compareHumanLabels, humanLabel } from "#src/lib/human-label";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { recordChannelMembersAdded } from "#src/server/app-notifications/channel-events.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import {
  authorizeChannelActor,
  channelEndSequence,
  findChannelById,
  memberChannel,
  type ChannelActor,
  type PublicChannelPorts,
} from "./channel-access.server";
import {
  channelActorMemberWhere,
  deriveChannelAdminBasis,
  deriveChannelCapabilities,
  resolveActorServerRole,
  resolveChannelAuthority,
} from "./channel-authority.server";
import { softLeaveMember, upsertChannelMembers } from "./channel-changes.server";
import { announceJoinedOrLeft } from "./conversation-realtime.server";
import {
  announceNotifiedPeople,
  claimMentionActions,
  notifyMentionTargets,
  publishNonMemberDeliveries,
  releaseMentionActions,
  type MentionActionResult,
} from "./pending-mention-actions.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";

/** Who is in a channel: joining and leaving it, adding and removing members, the roster with the
 * actor's capabilities, and the sender's follow-up on a mention of someone outside it. */

export async function joinChannel(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  // Nobody joins an archived channel; its members keep reading it.
  if (channel.archivedAt) throw new AppError("CONFLICT");
  // Upsert (not createMany/skipDuplicates): a human previously removed from this channel by
  // an admin Agent has a row with `leftAt` set, which re-joining must clear rather than skip.
  // (Re-)joining starts already-read at the channel's current top-level end: the badge
  // counts what arrives *after* you joined, never the backlog that existed before.
  const alreadyIn = await db.$transaction(async (tx) => {
    const active = await tx.conversationMember.count({
      where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
    });
    await tx.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: channelId, userId } },
      create: { workspaceId, userId, conversationId: channelId },
      update: { leftAt: null },
    });
    await tx.conversationMember.updateMany({
      where: { conversationId: channelId, userId },
      data: { readThroughSequence: await channelEndSequence(tx, channelId) },
    });
    if (active === 0) await recordChannelMembersAdded(tx, workspaceId, channelId, [{ userId }]);
    return active > 0;
  });
  if (!alreadyIn)
    await announceJoinedOrLeft(realtime, {
      workspaceId,
      conversationId: channelId,
      change: "joined",
      userIds: [userId],
    });
}

/**
 * A human leaves a public channel they are an active member of themselves ("Leave a channel",
 * Slack: any member may leave a channel they belong to). Never `#general` (`CONFLICT`, Slack:
 * "It's not possible to leave the default #general channel"). Soft-left (`leftAt` set), not
 * deleted: the same row's mute preference and read boundary survive a later `join`, which clears
 * `leftAt` again.
 */
export async function leaveChannel(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  if (channel.channelName === "general") throw new AppError("CONFLICT");
  const wasMember = await softLeaveMember(db, workspaceId, channel.id, { userId });
  if (!wasMember) throw new AppError("ACCESS_DENIED");
  await announceJoinedOrLeft(realtime, {
    workspaceId,
    conversationId: channel.id,
    change: "left",
    userIds: [userId],
  });
  return { left: true };
}

/**
 * A channel admin (either basis) removes a human or Agent from a public channel — originally
 * Slack's "Workspace Owners and Admins can remove people from public channels", now
 * generalized to the `remove_member` capability so a channel admin via stored
 * `channelRole` may also remove members from a channel it administers, the same authority the
 * Agent CLI's `remove-member` already has. Never `#general` (`CONFLICT`, Slack:
 * "It's not possible to remove people from the #general … channel"). A plain member without
 * either admin basis is denied `ACCESS_DENIED` before any row is touched. Soft-left, same as
 * `leave`: messages, tasks and thread history stay; the row (mute preference, read boundary)
 * survives for a later re-add/rejoin.
 */
export async function removeChannelMember(
  { db, realtime, inboxPurge }: PublicChannelPorts,
  workspaceId: string,
  actorUserId: string,
  channelId: string,
  target: ChannelActor,
) {
  const channel = await findChannelById(db, workspaceId, channelId);
  if (channel.channelName === "general") throw new AppError("CONFLICT");
  const authority = await resolveChannelAuthority(
    db,
    workspaceId,
    { userId: actorUserId },
    channel,
  );
  if (!authority.capabilities.remove_member) throw new AppError("ACCESS_DENIED");
  const wasMember = await softLeaveMember(db, workspaceId, channel.id, target);
  if (wasMember)
    await announceJoinedOrLeft(realtime, {
      workspaceId,
      conversationId: channel.id,
      change: "left",
      userIds: "userId" in target ? [target.userId] : [],
    });
  if (wasMember && "agentId" in target)
    await inboxPurge.purge({
      workspaceId,
      agentId: target.agentId,
      conversationIds: [channel.id],
      reason: "member_removed",
    });
  return { removed: true, wasMember };
}

/**
 * Current members split into humans and Agents, plus candidates (Workspace
 * humans and Agents not yet members) and whether the actor may add members
 * (has an active ConversationMember row in this channel). Any Workspace
 * member or Agent may read this; channels are public within the Workspace.
 * Shared by the human "Members" dialog and the Agent CLI's `channel
 * members`/`add-member`; a soft-left row (`leftAt` set)
 * never counts as a current member.
 */
export async function channelMembers(
  { db }: PublicChannelPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
) {
  await authorizeChannelActor(db, workspaceId, actor);
  const channel = await findChannelById(db, workspaceId, channelId);
  const isGeneral = channel.channelName === "general";

  const [memberRows, workspaceUsers, workspaceAgents, actorServerRole] = await Promise.all([
    db.conversationMember.findMany({
      where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
      select: {
        channelRole: true,
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            description: true,
            avatarObjectKey: true,
          },
        },
        agent: {
          select: {
            id: true,
            name: true,
            displayName: true,
            description: true,
            role: true,
            computerId: true,
            avatarMascot: true,
          },
        },
      },
    }),
    db.user.findMany({
      where: { memberships: { some: { workspaceId } } },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarObjectKey: true,
      },
    }),
    // A private Agent can never join a channel, so it is never an add-candidate
    // either — unconditionally, the same "channels never contain a private Agent" invariant
    // `addMembers` enforces, not a viewer-scoped visibility read.
    db.agent.findMany({
      where: {
        workspaceId,
        weeklyReportAssistant: null,
        visibility: AGENT_VISIBILITY.PUBLIC,
        ...ACTIVE_AGENT_WHERE,
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        avatarMascot: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    // The actor's own server role (Workspace role for a human, Agent.role for an Agent),
    // independent of whether they are a member of *this* channel: an owner/admin who has
    // never joined a channel may still archive/remove-member/manage-roles on it.
    resolveActorServerRole(db, workspaceId, actor),
  ]);

  const memberUserIds = new Set(memberRows.flatMap((row) => (row.user ? [row.user.id] : [])));
  const memberAgentIds = new Set(memberRows.flatMap((row) => (row.agent ? [row.agent.id] : [])));
  const humanRoles = memberUserIds.size
    ? await db.workspaceMembership.findMany({
        where: { workspaceId, userId: { in: [...memberUserIds] } },
        select: { userId: true, role: true },
      })
    : [];
  const roleByUserId = new Map(humanRoles.map((row) => [row.userId, row.role]));

  const actorRow = memberRows.find((row) =>
    "userId" in actor ? row.user?.id === actor.userId : row.agent?.id === actor.agentId,
  );
  const isActiveMember = Boolean(actorRow);
  const actorAdminBasis = deriveChannelAdminBasis(actorServerRole, actorRow?.channelRole);
  const capabilities = deriveChannelCapabilities({
    isHuman: "userId" in actor,
    isActiveMember,
    isGeneral,
    adminBasis: actorAdminBasis,
  });

  return {
    // Nobody adds members to an archived channel.
    canAddMembers: isActiveMember && channel.archivedAt === null,
    // The actor's own channel role/admin basis/capabilities on this channel.
    channelRole: actorRow?.channelRole,
    channelAdminBasis: actorAdminBasis,
    channelCapabilities: capabilities,
    // Alias of the capability matrix above for the members page's Remove action: a channel
    // admin via `channelRole` (not just a Workspace owner/admin) may also remove members from a
    // channel it administers.
    canRemoveMembers: capabilities.remove_member,
    humans: memberRows
      .filter((row) => row.user)
      .map((row) => {
        const serverRole = roleByUserId.get(row.user!.id) ?? "member";
        return {
          id: row.user!.id,
          // The browser lists a person by `displayName`; the handle is for the Agent-facing
          // roster (`agent-channel-management.server.ts`), which names people by it.
          username: row.user!.username,
          displayName: humanLabel(row.user!),
          description: row.user!.description,
          avatarUrl: workspaceUserAvatarUrl(workspaceId, row.user!.id, row.user!.avatarObjectKey),
          serverRole,
          channelRole: row.channelRole,
          channelAdminBasis: deriveChannelAdminBasis(serverRole, row.channelRole),
        };
      }),
    agents: memberRows
      .filter((row) => row.agent)
      .map((row) => ({
        id: row.agent!.id,
        name: row.agent!.name,
        displayName: row.agent!.displayName?.trim() || row.agent!.name,
        description: row.agent!.description,
        avatarUrl: agentAvatarUrl(row.agent!.id, row.agent!.avatarMascot),
        serverRole: row.agent!.role,
        channelRole: row.channelRole,
        channelAdminBasis: deriveChannelAdminBasis(row.agent!.role, row.channelRole),
        computerId: row.agent!.computerId,
      })),
    candidates: {
      humans: workspaceUsers
        .filter((user) => !memberUserIds.has(user.id))
        .sort(compareHumanLabels)
        .map((user) => ({
          id: user.id,
          displayName: humanLabel(user),
          avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
        })),
      agents: workspaceAgents
        .filter((agent) => !memberAgentIds.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          displayName: agent.displayName?.trim() || agent.name,
          description: agent.description,
          avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
        })),
    },
  };
}

/**
 * A channel member adds Workspace humans and/or Agents as channel members
 * (Slack: you add people to channels you belong to). Membership alone never
 * creates attention: delivery eligibility is computed at message time.
 * Adding someone whose row exists but is soft-left (`leftAt` set) clears
 * `leftAt` rather than being a no-op, and keeps their prior read boundary
 * and mute preference (upsert, not `createMany`/`skipDuplicates`).
 */
export async function addChannelMembers(
  ports: PublicChannelPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  input: { userIds: string[]; agentIds: string[] },
) {
  const { db, realtime } = ports;
  await authorizeChannelActor(db, workspaceId, actor);
  const channel = await findChannelById(db, workspaceId, channelId);
  // Nobody joins an archived channel, including by being added.
  if (channel.archivedAt) throw new AppError("CONFLICT");

  const actorMembership = await db.conversationMember.findFirst({
    where: {
      conversationId: channelId,
      ...channelActorMemberWhere(actor),
      ...ACTIVE_MEMBER_WHERE,
    },
    select: { id: true },
  });
  if (!actorMembership) throw new AppError("ACCESS_DENIED");

  const userIds = [...new Set(input.userIds)];
  const agentIds = [...new Set(input.agentIds)];
  if (userIds.length) {
    const validUsers = await db.workspaceMembership.count({
      where: { workspaceId, userId: { in: userIds } },
    });
    if (validUsers !== userIds.length) throw new AppError("INVALID_INPUT");
  }
  if (agentIds.length) {
    const targetAgents = await db.agent.findMany({
      where: { workspaceId, id: { in: agentIds }, ...ACTIVE_AGENT_WHERE },
      select: { id: true, visibility: true },
    });
    if (targetAgents.length !== agentIds.length) throw new AppError("INVALID_INPUT");
    // A private Agent is never an active channel member — reject the whole add
    // rather than silently drop it, with a stable code + explanation for the caller.
    if (targetAgents.some((agent) => agent.visibility !== AGENT_VISIBILITY.PUBLIC))
      throw new AppError("INVALID_INPUT", { errorId: "agent-private" });
  }

  // Read who was already an active member before writing, so a caller (the Agent CLI) can
  // report "already in #channel" instead of a bare success for a no-op add.
  const alreadyActive = await db.conversationMember.findMany({
    where: {
      conversationId: channelId,
      ...ACTIVE_MEMBER_WHERE,
      OR: [
        ...(userIds.length ? [{ userId: { in: userIds } }] : []),
        ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
      ],
    },
    select: { userId: true, agentId: true },
  });
  const alreadyMemberUserIds = alreadyActive.flatMap((row) => (row.userId ? [row.userId] : []));
  const alreadyMemberAgentIds = alreadyActive.flatMap((row) => (row.agentId ? [row.agentId] : []));

  // (Re-)added members start already-read at the channel's current end: the badge counts
  // what arrives after the add, never the backlog that existed before (mirrors `join`). An
  // already-active member keeps the read position they had — re-adding is a no-op.
  const readThroughSequence = await channelEndSequence(db, channelId);
  await upsertChannelMembers(
    db,
    { workspaceId, channelId, readThroughSequence },
    {
      userIds,
      agentIds,
      alreadyMemberUserIds,
      alreadyMemberAgentIds,
    },
  );
  const alreadyActiveUserIds = new Set(alreadyMemberUserIds);
  const added =
    userIds.length - alreadyMemberUserIds.length + agentIds.length - alreadyMemberAgentIds.length;
  if (added > 0)
    await announceJoinedOrLeft(realtime, {
      workspaceId,
      conversationId: channelId,
      change: "joined",
      userIds: userIds.filter((userId) => !alreadyActiveUserIds.has(userId)),
    });

  const result = await channelMembers(ports, workspaceId, actor, channelId);
  return { ...result, alreadyMemberUserIds, alreadyMemberAgentIds };
}

/**
 * The sender acts on mentions of their messages that did not reach their target: `notify` has
 * each target read that one message (see `notifyMentionTargets`); `add` makes each target a
 * member of the channel it was mentioned in, under the sender's own authority to add members.
 * Results come back in request order, one per distinct resolution id.
 */
export async function executeMentionActions(
  ports: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  action: "notify" | "add",
  resolutionIds: readonly string[],
): Promise<MentionActionResult[]> {
  const { db, realtime, publisher } = ports;
  await requireWorkspaceMember(db, workspaceId, userId);
  if (action === "notify") {
    const { results, deliveries, notifiedUserIds } = await notifyMentionTargets(
      db,
      workspaceId,
      { userId },
      resolutionIds,
    );
    await publishNonMemberDeliveries(
      db,
      publisher ?? createCentrifugoServerApi(),
      workspaceId,
      deliveries,
    );
    await announceNotifiedPeople(realtime, workspaceId, notifiedUserIds);
    return results;
  }
  const { refused, claimed } = await claimMentionActions(
    db,
    workspaceId,
    { userId },
    resolutionIds,
  );
  const results = new Map(refused.map((result) => [result.resolutionId, result]));
  const byChannel = new Map<string, typeof claimed>();
  for (const claim of claimed)
    byChannel.set(claim.conversationId, [...(byChannel.get(claim.conversationId) ?? []), claim]);
  for (const [channelId, claims] of byChannel) {
    try {
      await addChannelMembers(ports, workspaceId, { userId }, channelId, {
        userIds: claims.flatMap((claim) => (claim.targetType === "user" ? [claim.targetId] : [])),
        agentIds: claims.flatMap((claim) => (claim.targetType === "agent" ? [claim.targetId] : [])),
      });
      for (const claim of claims)
        results.set(claim.resolutionId, {
          resolutionId: claim.resolutionId,
          status: "delivered",
          targetType: claim.targetType,
          targetId: claim.targetId,
          targetHandle: claim.targetHandle,
        });
    } catch (error) {
      await releaseMentionActions(db, claims);
      if (!isAppError(error)) throw error;
      for (const claim of claims)
        results.set(claim.resolutionId, {
          resolutionId: claim.resolutionId,
          status: "no_permission",
          reason: "could_not_apply",
          targetType: claim.targetType,
          targetId: claim.targetId,
          targetHandle: claim.targetHandle,
        });
    }
  }
  return [...new Set(resolutionIds)].map((id) => results.get(id)!);
}
