import { agentChannelReader } from "#src/server/agents/workspace-assistant-authority.server";
import type { Conversation, PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import {
  AgentChannelManagementError,
  channelAuthorityDeniedError,
} from "./agent-channel-management-error.server";
import { PublicChannels } from "./public-channels.server";
import { softLeaveMember } from "./channel-changes.server";
import { joinChannelAsAgent } from "./agent-channel-join.server";
import { announceMemberChanged, type ConversationRealtime } from "./conversation-realtime.server";
import { announceJoinedOrLeft } from "./channel-membership-signals.server";
import { assertCallerNotPrivate, createAgentChannel } from "./agent-channel-create.server";

import { hasChannelAdminAuthority } from "./channel-authority.server";
import type { ChannelActor } from "./channel-actor.server";
import { visibleChannelWhere } from "./channel-read-access.server";
import type { AgentDisplay } from "#src/server/agents/agent-display.server";
import {
  agentChannelInfo,
  directConversationRoster,
  shapeAgentRoster,
  type AgentChannelInfo,
  type AgentChannelRoster,
} from "./agent-channel-reads.server";
import {
  memberNotFound,
  normalizeChannelName,
  parseChannelTarget,
  parseMemberInput,
  USER_TARGET,
  type AgentChannelMemberInput,
} from "./agent-channel-targets.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";

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
    const actor = await agentChannelReader(this.db, workspaceId, agentId);
    const { channel } = await this.targetChannel(workspaceId, actor, target);
    return agentChannelInfo(this.db, workspaceId, channel, actor);
  }

  async members(workspaceId: string, agentId: string, target: string): Promise<AgentChannelRoster> {
    const parentTarget = target.split(":")[0] ?? "";
    if (parentTarget.startsWith("#")) {
      const actor = await agentChannelReader(this.db, workspaceId, agentId);
      const { channel } = await this.targetChannel(workspaceId, actor, parentTarget);
      const raw = await this.channels.members(workspaceId, actor, channel.id);
      return shapeAgentRoster(this.display, workspaceId, agentId, `#${channel.channelName}`, raw);
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
    return directConversationRoster(
      this.db,
      this.display,
      workspaceId,
      conversation.id,
      agentId,
      parentTarget,
    );
  }

  async join(workspaceId: string, agentId: string, target: string) {
    const actor = await agentChannelReader(this.db, workspaceId, agentId);
    const { channel } = await this.targetChannel(workspaceId, actor, target);
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    if ("userId" in actor) {
      const before = await this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, userId: actor.userId, leftAt: null },
        select: { id: true },
      });
      await this.channels.join(workspaceId, actor.userId!, channel.id);
      return { target: `#${channel.channelName}`, joined: true, alreadyJoined: Boolean(before) };
    }
    await assertCallerNotPrivate(this.db, workspaceId, agentId, "join");
    const joined = await joinChannelAsAgent(this.db, workspaceId, channel.id, agentId);
    if (joined)
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
    return { target: `#${channel.channelName}`, joined: true, alreadyJoined: !joined };
  }

  async leave(workspaceId: string, agentId: string, target: string) {
    // Looked up first: a #general hidden from the Workspace is an unknown channel, not a refusal.
    const actor = await agentChannelReader(this.db, workspaceId, agentId);
    const { channelName, channel } = await this.targetChannel(workspaceId, actor, target);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot leave #general");
    if ("userId" in actor) {
      const before = await this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, userId: actor.userId, leftAt: null },
        select: { id: true },
      });
      await this.channels.leave(workspaceId, actor.userId!, channel.id);
      return { target: `#${channel.channelName}`, joined: false, wasMember: Boolean(before) };
    }
    const wasMember = await this.markLeft(workspaceId, channel.id, { agentId });
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
    return createAgentChannel(
      { db: this.db, channels: this.channels, realtime: this.realtime },
      workspaceId,
      agentId,
      rawName,
      description,
    );
  }

  async update(
    workspaceId: string,
    agentId: string,
    target: string,
    patch: { name?: string; description?: string },
  ): Promise<AgentChannelInfo> {
    if (patch.name === undefined && patch.description === undefined)
      throw new AgentChannelManagementError(400, "update requires --name or --description");
    const actor = await agentChannelReader(this.db, workspaceId, agentId);
    const { channelName, channel } = await this.targetChannel(workspaceId, actor, target);
    // Authority before the input is judged, so an Agent without it learns nothing else.
    if (!(await hasChannelAdminAuthority(this.db, workspaceId, actor, channel)))
      throw channelAuthorityDeniedError("update");
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    let nextName: string | undefined;
    if (patch.name !== undefined) {
      if (channelName === "general")
        throw new AgentChannelManagementError(400, "cannot rename #general");
      nextName = normalizeChannelName(patch.name);
      if (nextName === "general") throw new AgentChannelManagementError(409, "general is reserved");
    }
    // Shared with the human settings panel, which applies the same authority and archive rules.
    try {
      await this.channels.updateInfo(workspaceId, actor, channel.id, {
        name: nextName,
        description: patch.description,
      });
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw channelAuthorityDeniedError("update");
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
    return agentChannelInfo(
      this.db,
      workspaceId,
      await this.findChannel(workspaceId, actor, nextName ?? channelName),
      actor,
    );
  }

  async setArchived(workspaceId: string, agentId: string, target: string, archived: boolean) {
    const operation = archived ? "archive" : "unarchive";
    const actor = await agentChannelReader(this.db, workspaceId, agentId);
    const { channelName, channel } = await this.targetChannel(workspaceId, actor, target);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, `cannot ${operation} #general`);
    try {
      await this.channels.setArchived(workspaceId, actor, channel.id, archived);
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
    const channelName = parseChannelTarget(target);
    const { kind, handle } = parseMemberInput(input);
    const actor = await agentChannelReader(this.db, workspaceId, callingAgentId);
    const channel = await this.findChannel(workspaceId, actor, channelName);
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
      const result = await this.channels.addMembers(workspaceId, actor, channel.id, {
        userIds: userId ? [userId] : [],
        agentIds: resolvedAgentId ? [resolvedAgentId] : [],
      });
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
    const channelName = parseChannelTarget(target);
    const { kind, handle } = parseMemberInput(input);
    const actor = await agentChannelReader(this.db, workspaceId, callingAgentId);
    const channel = await this.findChannel(workspaceId, actor, channelName);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot remove a member from #general");
    let wasMember: boolean;
    let removedAgentId: string | undefined;
    let removedUserIds: string[] = [];
    // Removing anyone but itself takes the calling Agent's channel-admin authority.
    const assertMayRemoveOthers = async () => {
      if (!(await hasChannelAdminAuthority(this.db, workspaceId, actor, channel)))
        throw channelAuthorityDeniedError("remove-member");
    };
    if (kind === "agent") {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle },
        select: { id: true },
      });
      if (!agentRow) throw memberNotFound(handle);
      if (agentRow.id !== callingAgentId) await assertMayRemoveOthers();
      wasMember = await this.markLeft(workspaceId, channel.id, { agentId: agentRow.id });
      if (wasMember) removedAgentId = agentRow.id;
    } else {
      await assertMayRemoveOthers();
      const user = await this.db.user.findUnique({ where: { username: handle } });
      if (!user) throw memberNotFound(handle);
      wasMember = await this.markLeft(workspaceId, channel.id, { userId: user.id });
      if (wasMember) removedUserIds = [user.id];
    }
    if (wasMember)
      await announceJoinedOrLeft(this.realtime, {
        workspaceId,
        conversationId: channel.id,
        change: "left",
        userIds: removedUserIds,
        private: channel.visibility === CHANNEL_VISIBILITY.PRIVATE,
        db: this.db,
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

  /** Ends one member's active membership of a channel; whether they were an active member. */
  private markLeft(
    workspaceId: string,
    conversationId: string,
    member: { agentId: string } | { userId: string },
  ): Promise<boolean> {
    return softLeaveMember(this.db, workspaceId, conversationId, member);
  }

  /** A `#channel` target and the channel it names that `reader` may read (400 if malformed, 404
   * if unknown). */
  private async targetChannel(workspaceId: string, reader: ChannelActor, target: string) {
    const channelName = parseChannelTarget(target);
    return { channelName, channel: await this.findChannel(workspaceId, reader, channelName) };
  }

  /** The channel named `channelName` that `reader` may read; a channel hidden from the Workspace,
   * or a private one `reader` is not in, is an unknown channel (`visibleChannelWhere`). */
  private async findChannel(
    workspaceId: string,
    reader: ChannelActor,
    channelName: string,
  ): Promise<Conversation> {
    const channel = await this.db.conversation.findFirst({
      where: { ...visibleChannelWhere(workspaceId, reader), channelName },
    });
    if (!channel) throw new AgentChannelManagementError(404, "channel not found");
    return channel;
  }
}
