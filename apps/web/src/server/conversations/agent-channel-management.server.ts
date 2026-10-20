import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import type { Conversation, PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import {
  AgentChannelManagementError,
  channelAuthorityDeniedError,
} from "./agent-channel-management-error.server";
import { PublicChannels } from "./public-channels.server";
import { attachDefaultMemoryAgent } from "#src/server/workspace-memory/default-memory-agent.server";
import { isOpenVikingPrototypeEnabled } from "#src/server/workspace-memory/prototype-gate";
import {
  announceChannelCreated,
  channelInfoOf,
  announceMemberChanged,
  announceJoinedOrLeft,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import {
  hasChannelAdminAuthority,
  resolveChannelAuthority,
  type ChannelAdminBasis,
  type ChannelCapabilities,
} from "./channel-authority.server";
import { resolveAgentChannelStatuses } from "#src/server/agents/agent-channel-status.server";
import { getAgentDisplay, type AgentDisplay } from "#src/server/agents/agent-display.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

const CHANNEL_TARGET = /^#[a-z0-9][a-z0-9_-]{0,31}$/;
const USER_TARGET = /^@[a-z0-9][a-z0-9_-]{0,31}$/;
const MEMBER_HANDLE = /^@[a-z0-9][a-z0-9_-]{0,31}$/;

export type AgentChannelInfo = {
  id: string;
  name: string;
  description: string;
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

export type AgentChannelMemberInput = { user?: string; agent?: string };

/** The seam route handlers depend on, so unit tests can supply a fake instead of Prisma. */
export type AgentChannelManagementRepository = Pick<
  AgentChannelManagement,
  | "info"
  | "members"
  | "join"
  | "leave"
  | "create"
  | "update"
  | "setArchived"
  | "addMember"
  | "removeMember"
>;

/** A member handle that names no one this operation can reach (404). */
function memberNotFound(handle: string) {
  return new AgentChannelManagementError(404, `member not found: @${handle}`);
}

/**
 * Workspace-scoped Agent channel lifecycle and rosters. ACTIVE_MEMBER_WHERE excludes soft-left targets.
 */
export class AgentChannelManagement {
  private readonly channels: PublicChannels;
  private readonly inboxPurge: Pick<AgentInboxPurgePublisher, "purge">;

  constructor(
    private readonly db: PrismaClient,
    private readonly display?: Pick<AgentDisplay, "snapshot" | "snapshotMany">,
    channels?: PublicChannels,
    // The whole port, not just `memberChanged`: it is also the default `PublicChannels`'.
    private readonly realtime?: ConversationRealtime,
    inboxPurge?: Pick<AgentInboxPurgePublisher, "purge">,
  ) {
    this.inboxPurge = inboxPurge ?? new AgentInboxPurgePublisher(db);
    // Reused (not reimplemented) so the human "Members" dialog and the Agent CLI's
    // `channel members`/`add-member` cannot drift.
    this.channels =
      channels ??
      new PublicChannels(db, undefined, undefined, undefined, realtime, this.inboxPurge);
  }

  async info(workspaceId: string, agentId: string, target: string): Promise<AgentChannelInfo> {
    const { channel } = await this.targetChannel(workspaceId, target);
    return this.channelInfo(workspaceId, channel, agentId);
  }

  async members(workspaceId: string, agentId: string, target: string): Promise<AgentChannelRoster> {
    const parentTarget = target.split(":")[0] ?? "";
    if (parentTarget.startsWith("#")) {
      const { channel } = await this.targetChannel(workspaceId, parentTarget);
      const raw = await this.channels.members(
        workspaceId,
        await this.actor(workspaceId, agentId),
        channel.id,
      );
      return this.shapeAgentRoster(workspaceId, agentId, `#${channel.channelName}`, raw);
    }
    if (!USER_TARGET.test(parentTarget))
      throw new AgentChannelManagementError(400, "target must be a #channel or @user");
    const username = parentTarget.slice(1);
    const user = await this.db.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) throw new AgentChannelManagementError(404, "channel not found");
    // Roster lookup never starts a DM; read/search/send may create one.
    const conversation = await new PrismaDirectConversationRepository(
      this.db,
    ).findUserAgentConversation(workspaceId, user.id, agentId);
    if (!conversation) throw new AgentChannelManagementError(404, "channel not found");
    return this.roster(workspaceId, conversation.id, agentId, parentTarget);
  }

  private async actor(workspaceId: string, agentId: string) {
    const user = await workspaceAssistantUser(this.db, workspaceId, agentId);
    return user ? { userId: user.userId } : { agentId };
  }

  async join(workspaceId: string, agentId: string, target: string) {
    const { channel } = await this.targetChannel(workspaceId, target);
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    const actor = await this.actor(workspaceId, agentId);
    if ("userId" in actor) {
      const before = await this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, userId: actor.userId, leftAt: null },
        select: { id: true },
      });
      await this.channels.join(workspaceId, actor.userId!, channel.id);
      return { target: `#${channel.channelName}`, joined: true, alreadyJoined: Boolean(before) };
    }
    await this.assertCallerNotPrivate(workspaceId, agentId, "join");
    const existing = await this.db.conversationMember.findFirst({
      where: { conversationId: channel.id, agentId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    });
    await this.db.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId: channel.id, agentId } },
      create: { conversationId: channel.id, workspaceId, agentId },
      update: { leftAt: null },
    });
    if (!existing)
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
    return { target: `#${channel.channelName}`, joined: true, alreadyJoined: Boolean(existing) };
  }

  async leave(workspaceId: string, agentId: string, target: string) {
    // Looked up first: a #general hidden from the Workspace is an unknown channel, not a refusal.
    const { channelName, channel } = await this.targetChannel(workspaceId, target);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot leave #general");
    const actor = await this.actor(workspaceId, agentId);
    if ("userId" in actor) {
      const before = await this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, userId: actor.userId, leftAt: null },
        select: { id: true },
      });
      await this.channels.leave(workspaceId, actor.userId!, channel.id);
      return { target: `#${channel.channelName}`, joined: false, wasMember: Boolean(before) };
    }
    const wasMember = await this.markLeft(channel.id, { agentId });
    if (wasMember) {
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
      await this.inboxPurge.purge({
        workspaceId,
        agentId,
        conversationIds: [channel.id],
        reason: "left",
      });
    }
    return { target: `#${channel.channelName}`, joined: false, wasMember };
  }

  async create(
    workspaceId: string,
    agentId: string,
    rawName: string,
    description: string | undefined,
  ) {
    const delegated = await workspaceAssistantUser(this.db, workspaceId, agentId);
    if (delegated) {
      const name = this.normalizeChannelName(rawName);
      const created = await this.channels.create(
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
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!agent)
      throw new AgentChannelManagementError(403, "this Agent does not belong to the Workspace");
    await this.assertCallerNotPrivate(workspaceId, agentId, "create");
    const name = this.normalizeChannelName(rawName);
    if (name === "general") throw new AgentChannelManagementError(409, "general is reserved");
    let channel: {
      id: string;
      channelName: string | null;
      description: string;
      archivedAt: Date | null;
    };
    try {
      channel = await this.db.conversation.create({
        data: {
          workspaceId,
          channelName: name,
          description: description ?? "",
          // The creator becomes the channel's first admin, same as a human creator.
          members: { create: { agentId, channelRole: "admin" } },
        },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
    await attachDefaultMemoryAgent(this.db, {
      workspaceId,
      conversationId: channel.id,
      actorUserId: agent.ownerId,
      now: new Date(),
      gate: { prototypeEnabled: isOpenVikingPrototypeEnabled(Bun.env) },
    });
    await announceChannelCreated(this.realtime, {
      workspaceId,
      conversationId: channel.id,
      channel: channelInfoOf(channel),
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

  async update(
    workspaceId: string,
    agentId: string,
    target: string,
    patch: { name?: string; description?: string },
  ): Promise<AgentChannelInfo> {
    if (patch.name === undefined && patch.description === undefined)
      throw new AgentChannelManagementError(400, "update requires --name or --description");
    const { channelName, channel } = await this.targetChannel(workspaceId, target);
    // Authority before the input is judged, so an Agent without it learns nothing else.
    if (
      !(await hasChannelAdminAuthority(
        this.db,
        workspaceId,
        await this.actor(workspaceId, agentId),
        channel,
      ))
    )
      throw channelAuthorityDeniedError("update");
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    let nextName: string | undefined;
    if (patch.name !== undefined) {
      if (channelName === "general")
        throw new AgentChannelManagementError(400, "cannot rename #general");
      nextName = this.normalizeChannelName(patch.name);
      if (nextName === "general") throw new AgentChannelManagementError(409, "general is reserved");
    }
    // Shared with the human settings panel, which applies the same authority and archive rules.
    try {
      await this.channels.updateInfo(
        workspaceId,
        await this.actor(workspaceId, agentId),
        channel.id,
        {
          name: nextName,
          description: patch.description,
        },
      );
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw channelAuthorityDeniedError("update");
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
    return this.channelInfo(
      workspaceId,
      await this.findChannel(workspaceId, nextName ?? channelName),
      agentId,
    );
  }

  async setArchived(workspaceId: string, agentId: string, target: string, archived: boolean) {
    const operation = archived ? "archive" : "unarchive";
    const { channelName, channel } = await this.targetChannel(workspaceId, target);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, `cannot ${operation} #general`);
    try {
      await this.channels.setArchived(
        workspaceId,
        await this.actor(workspaceId, agentId),
        channel.id,
        archived,
      );
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw channelAuthorityDeniedError(operation);
      throw error;
    }
    return { target: `#${channel.channelName}`, archived };
  }

  /**
   * PublicChannels.addMembers enforces active actor membership. Resolve handles and reshape
   * CLI output here; distinguish unknown handles from targets the actor cannot add.
   */
  async addMember(
    workspaceId: string,
    callingAgentId: string,
    target: string,
    input: AgentChannelMemberInput,
  ) {
    const channelName = this.parseChannelTarget(target);
    const { kind, handle } = this.parseMemberInput(input);
    const channel = await this.findChannel(workspaceId, channelName);
    let userId: string | undefined;
    let resolvedAgentId: string | undefined;
    if (kind === "user") {
      const user = await this.db.user.findUnique({
        where: { username: handle },
        select: { id: true },
      });
      if (!user) throw memberNotFound(handle);
      userId = user.id;
    } else {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle, ...ACTIVE_AGENT_WHERE },
        select: { id: true, ownerId: true, visibility: true, systemKind: true },
      });
      if (!agentRow) throw memberNotFound(handle);
      // Invisible private targets return agent_not_visible; nonexistent handles return member not found.
      // Visible private Agents still cannot join channels. PublicChannels enforces this too;
      // the early refusal gives the caller a useful reason.
      const viewer = await agentVisibilityViewerForActor(this.db, workspaceId, {
        agentId: callingAgentId,
      });
      if (!canSeeAgent(viewer, agentRow))
        throw new AgentChannelManagementError(
          404,
          `@${handle} is not visible to you.`,
          "agent_not_visible",
        );
      if (agentRow.visibility !== AGENT_VISIBILITY.PUBLIC)
        throw new AgentChannelManagementError(
          400,
          `@${handle} is private and cannot be added to a channel`,
        );
      resolvedAgentId = agentRow.id;
    }
    let alreadyMember = false;
    try {
      const result = await this.channels.addMembers(
        workspaceId,
        await this.actor(workspaceId, callingAgentId),
        channel.id,
        {
          userIds: userId ? [userId] : [],
          agentIds: resolvedAgentId ? [resolvedAgentId] : [],
        },
      );
      alreadyMember = userId
        ? result.alreadyMemberUserIds.includes(userId)
        : result.alreadyMemberAgentIds.includes(resolvedAgentId!);
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED"))
        throw new AgentChannelManagementError(
          403,
          `this Agent must be a member of #${channel.channelName} to add members to it`,
        );
      if (isAppErrorCode(error, "INVALID_INPUT", "NOT_FOUND")) throw memberNotFound(handle);
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel is archived");
      throw error;
    }
    return {
      target: `#${channel.channelName}`,
      member: { kind, handle: `@${handle}` },
      added: true as const,
      alreadyMember,
    };
  }

  async removeMember(
    workspaceId: string,
    callingAgentId: string,
    target: string,
    input: AgentChannelMemberInput,
  ) {
    const channelName = this.parseChannelTarget(target);
    const { kind, handle } = this.parseMemberInput(input);
    const channel = await this.findChannel(workspaceId, channelName);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot remove a member from #general");
    let wasMember: boolean;
    let removedAgentId: string | undefined;
    let removedUserIds: string[] = [];
    // Removing anyone but itself takes the calling Agent's channel-admin authority.
    const assertMayRemoveOthers = async () => {
      if (
        !(await hasChannelAdminAuthority(
          this.db,
          workspaceId,
          await this.actor(workspaceId, callingAgentId),
          channel,
        ))
      )
        throw channelAuthorityDeniedError("remove-member");
    };
    if (kind === "agent") {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle },
        select: { id: true },
      });
      if (!agentRow) throw memberNotFound(handle);
      if (agentRow.id !== callingAgentId) await assertMayRemoveOthers();
      wasMember = await this.markLeft(channel.id, { agentId: agentRow.id });
      if (wasMember) removedAgentId = agentRow.id;
    } else {
      await assertMayRemoveOthers();
      const user = await this.db.user.findUnique({ where: { username: handle } });
      if (!user) throw memberNotFound(handle);
      wasMember = await this.markLeft(channel.id, { userId: user.id });
      if (wasMember) removedUserIds = [user.id];
    }
    if (wasMember)
      await announceJoinedOrLeft(this.realtime, {
        workspaceId,
        conversationId: channel.id,
        change: "left",
        userIds: removedUserIds,
      });
    if (removedAgentId)
      await this.inboxPurge.purge({
        workspaceId,
        agentId: removedAgentId,
        conversationIds: [channel.id],
        reason: "member_removed",
      });
    return { target: `#${channel.channelName}`, removed: true as const, wasMember };
  }

  /**
   * Ordinary private Agents cannot join/create channels; shared by join and create.
   */
  private async assertCallerNotPrivate(
    workspaceId: string,
    agentId: string,
    operation: "join" | "create",
  ): Promise<void> {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { visibility: true, systemKind: true },
    });
    if (!agent || agent.visibility !== AGENT_VISIBILITY.PUBLIC)
      throw new AgentChannelManagementError(403, `a private Agent cannot ${operation} a channel`);
  }

  /** Ends one member's active membership of a channel; whether they were an active member. */
  private async markLeft(
    conversationId: string,
    member: { agentId: string } | { userId: string },
  ): Promise<boolean> {
    const result = await this.db.conversationMember.updateMany({
      where: { conversationId, ...member, ...ACTIVE_MEMBER_WHERE },
      data: { leftAt: new Date() },
    });
    return result.count > 0;
  }

  /** A `#channel` target and the visible channel it names (400 if malformed, 404 if unknown). */
  private async targetChannel(workspaceId: string, target: string) {
    const channelName = this.parseChannelTarget(target);
    return { channelName, channel: await this.findChannel(workspaceId, channelName) };
  }

  private async findChannel(workspaceId: string, channelName: string): Promise<Conversation> {
    const channel = await this.db.conversation.findUnique({
      where: { workspaceId_channelName: { workspaceId, channelName } },
    });
    // A channel hidden from the Workspace is an unknown channel to an Agent.
    if (!channel || channel.hiddenFromWorkspaceAt)
      throw new AgentChannelManagementError(404, "channel not found");
    return channel;
  }

  private async channelInfo(
    workspaceId: string,
    channel: Pick<Conversation, "id" | "channelName" | "description" | "archivedAt" | "projectId">,
    agentId: string,
  ): Promise<AgentChannelInfo> {
    const actor = await this.actor(workspaceId, agentId);
    const [member, memberCounts, authority, project] = await Promise.all([
      this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, ...actor, ...ACTIVE_MEMBER_WHERE },
        select: { channelMuted: true },
      }),
      this.memberCounts(channel.id),
      resolveChannelAuthority(this.db, workspaceId, actor, channel),
      this.channelProject(workspaceId, channel.projectId),
    ]);
    return {
      id: channel.id,
      name: `#${channel.channelName}`,
      description: channel.description,
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
  private async channelProject(
    workspaceId: string,
    projectId: string | null,
  ): Promise<AgentChannelInfo["project"]> {
    if (!projectId) return undefined;
    const project = await this.db.project.findFirst({
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

  private async memberCounts(conversationId: string) {
    const [agents, humans] = await Promise.all([
      this.db.conversationMember.count({
        where: { conversationId, agentId: { not: null }, ...ACTIVE_MEMBER_WHERE },
      }),
      this.db.conversationMember.count({
        where: { conversationId, userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
      }),
    ]);
    return { agents, humans };
  }

  /**
   * DM roster: query directly because PublicChannels.members requires a named channel.
   */
  private async roster(
    workspaceId: string,
    conversationId: string,
    callingAgentId: string,
    target: string,
  ): Promise<AgentChannelRoster> {
    const rows = await this.db.conversationMember.findMany({
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
      ? await this.db.workspaceMembership.findMany({
          where: { workspaceId, userId: { in: humanRows.map((row) => row.id) } },
          select: { userId: true, role: true },
        })
      : [];
    const roleByUserId = new Map(roles.map((role) => [role.userId, role.role]));
    // DM entries omit channelRole/channelAdminBasis.
    return this.shapeAgentRoster(workspaceId, callingAgentId, target, {
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
  private async shapeAgentRoster(
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
      this.resolvedDisplay(),
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
  private resolvedDisplay(): Pick<AgentDisplay, "snapshot" | "snapshotMany"> {
    return (
      this.display ?? {
        snapshot: (scope) => getAgentDisplay().snapshot(scope),
        snapshotMany: (scopes) => getAgentDisplay().snapshotMany(scopes),
      }
    );
  }

  private parseChannelTarget(target: string): string {
    if (!CHANNEL_TARGET.test(target))
      throw new AgentChannelManagementError(400, "target must be a #channel");
    return target.slice(1);
  }

  private normalizeChannelName(rawName: string): string {
    const name = rawName.startsWith("#") ? rawName.slice(1) : rawName;
    if (!CHANNEL_NAME_PATTERN.test(name))
      throw new AgentChannelManagementError(400, "invalid channel name");
    return name;
  }

  private parseMemberInput(input: AgentChannelMemberInput): {
    kind: "user" | "agent";
    handle: string;
  } {
    if ((input.user === undefined) === (input.agent === undefined))
      throw new AgentChannelManagementError(400, "exactly one of --user or --agent is required");
    const kind: "user" | "agent" = input.user !== undefined ? "user" : "agent";
    const raw = (input.user ?? input.agent)!;
    if (!MEMBER_HANDLE.test(raw))
      throw new AgentChannelManagementError(400, "member handle must be an @handle");
    return { kind, handle: raw.slice(1) };
  }
}
