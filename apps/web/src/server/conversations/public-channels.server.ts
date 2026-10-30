import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { BulkFileRemoval } from "#src/server/files/file-storage.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { memberChannel, type PublicChannelPorts } from "./channel-access.server";
import type { ChannelActor } from "./channel-actor.server";
import { sendChannel } from "./channel-send.server";
import { changeChannelCoordinator } from "./channel-coordination.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { archivedChannels, channelNames, listChannels } from "./channel-directory.server";
import {
  changeChannelArchived,
  changeChannelInfo,
  createChannelWithMembers,
  createUserChannel,
  deleteChannel,
  isGeneralHidden,
  setChannelRole,
  setGeneralHidden,
} from "./channel-lifecycle.server";
import { mentionDirectory, mentionOutsiders } from "./channel-mentionables.server";
import { channelUpdates, openChannel } from "./channel-page.server";
import {
  setAgentMuted,
  setCollapseLongMessages,
  setUserHidden,
  setUserMuted,
  setUserPinned,
  setUserUnread,
} from "./channel-preferences.server";
import { markPublicChannelRead } from "./channel-read.server";
import {
  addChannelMembers,
  channelMembers,
  executeMentionActions,
  joinChannel,
  leaveChannel,
  removeChannelMember,
} from "./channel-roster.server";
import {
  markThreadReadForUser,
  setAgentThreadFollowed,
  setUserThreadFollowed,
  threadFollowingAgents,
  unfollowAgentFromThread,
} from "./channel-threads.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { toggleUserMessageReaction } from "./user-message-reactions.server";

/**
 * Workspace-visible history with per-Agent notification preferences. The facade every caller
 * holds: each operation lives in the channel module that owns it (`channel-*.server.ts`), and
 * this class hands it the ports it was built with.
 */
export class PublicChannels {
  private readonly ports: PublicChannelPorts;

  constructor(
    private readonly db: PrismaClient,
    private readonly idempotency?: MessageRequestIdempotency,
    private readonly publisher?: CentrifugoServerApi,
    private readonly notifications?: MessageNotifier,
    private readonly realtime?: ConversationRealtime,
    inboxPurge?: Pick<AgentInboxPurgePublisher, "purge">,
  ) {
    this.ports = {
      db,
      publisher,
      realtime,
      inboxPurge: inboxPurge ?? new AgentInboxPurgePublisher(db, publisher),
    };
  }

  setAgentMuted(workspaceId: string, agentId: string, target: string, muted: boolean) {
    return setAgentMuted(this.ports, workspaceId, agentId, target, muted);
  }

  /** Routes new, unmentioned top-level channel messages to one Agent first. */
  async setCoordinator(
    workspaceId: string,
    userId: string,
    channelId: string,
    coordinatorAgentId: string | null,
  ) {
    return changeChannelCoordinator(
      this.db,
      this.publisher ?? createCentrifugoServerApi(),
      this.realtime,
      workspaceId,
      userId,
      await memberChannel(this.db, workspaceId, userId, channelId),
      coordinatorAgentId,
    );
  }

  setAgentThreadFollowed(workspaceId: string, agentId: string, target: string, followed: boolean) {
    return setAgentThreadFollowed(this.ports, workspaceId, agentId, target, followed);
  }

  setUserMuted(workspaceId: string, userId: string, channelId: string, muted: boolean) {
    return setUserMuted(this.ports, workspaceId, userId, channelId, muted);
  }

  setCollapseLongMessages(
    workspaceId: string,
    userId: string,
    channelId: string,
    collapseLongMessages: boolean,
  ) {
    return setCollapseLongMessages(
      this.ports,
      workspaceId,
      userId,
      channelId,
      collapseLongMessages,
    );
  }

  setUserPinned(
    workspaceId: string,
    userId: string,
    channelId: string,
    pinned: boolean,
    sortOrder?: number,
  ) {
    return setUserPinned(this.ports, workspaceId, userId, channelId, pinned, sortOrder);
  }

  setUserUnread(workspaceId: string, userId: string, channelId: string, unread: boolean) {
    return setUserUnread(this.ports, workspaceId, userId, channelId, unread);
  }

  setUserHidden(workspaceId: string, userId: string, channelId: string, hidden: boolean) {
    return setUserHidden(this.ports, workspaceId, userId, channelId, hidden);
  }

  setUserThreadFollowed(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    followed: boolean,
  ) {
    return setUserThreadFollowed(
      this.ports,
      workspaceId,
      userId,
      channelId,
      rootMessageId,
      followed,
    );
  }

  threadFollowingAgents(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
  ) {
    return threadFollowingAgents(this.ports, workspaceId, userId, channelId, rootMessageId);
  }

  unfollowAgentFromThread(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    agentId: string,
  ) {
    return unfollowAgentFromThread(
      this.ports,
      workspaceId,
      userId,
      channelId,
      rootMessageId,
      agentId,
    );
  }

  markThreadReadForUser(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    throughSequence: number,
  ) {
    return markThreadReadForUser(
      this.ports,
      workspaceId,
      userId,
      channelId,
      rootMessageId,
      throughSequence,
    );
  }

  names(workspaceId: string, userId: string) {
    return channelNames(this.ports, workspaceId, userId);
  }

  list(workspaceId: string, userId: string) {
    return listChannels(this.ports, workspaceId, userId);
  }

  archived(workspaceId: string, userId: string) {
    return archivedChannels(this.ports, workspaceId, userId);
  }

  create(
    workspaceId: string,
    userId: string,
    name: string,
    projectId?: string,
    description?: string,
  ) {
    return createUserChannel(this.ports, workspaceId, userId, name, projectId, description);
  }

  createWithMembers(
    workspaceId: string,
    userId: string,
    input: { name: string; projectId?: string; userIds: string[]; agentIds: string[] },
  ) {
    return createChannelWithMembers(this.ports, workspaceId, userId, input);
  }

  setChannelRole(
    workspaceId: string,
    actorUserId: string,
    channelId: string,
    member: ChannelActor,
    role: string,
  ) {
    return setChannelRole(this.ports, workspaceId, actorUserId, channelId, member, role);
  }

  updateInfo(
    workspaceId: string,
    actor: ChannelActor,
    channelId: string,
    patch: { name?: string; description?: string },
  ) {
    return changeChannelInfo(this.ports, workspaceId, actor, channelId, patch);
  }

  generalHidden(workspaceId: string, userId: string) {
    return isGeneralHidden(this.ports, workspaceId, userId);
  }

  setGeneralHidden(workspaceId: string, userId: string, hidden: boolean) {
    return setGeneralHidden(this.ports, workspaceId, userId, hidden);
  }

  deleteChannel(
    workspaceId: string,
    userId: string,
    channelId: string,
    storage?: () => Promise<BulkFileRemoval>,
  ) {
    return deleteChannel(this.ports, workspaceId, userId, channelId, storage);
  }

  setArchived(workspaceId: string, actor: ChannelActor, channelId: string, archived: boolean) {
    return changeChannelArchived(this.ports, workspaceId, actor, channelId, archived);
  }

  join(workspaceId: string, userId: string, channelId: string) {
    return joinChannel(this.ports, workspaceId, userId, channelId);
  }

  leave(workspaceId: string, userId: string, channelId: string) {
    return leaveChannel(this.ports, workspaceId, userId, channelId);
  }

  removeMember(workspaceId: string, actorUserId: string, channelId: string, target: ChannelActor) {
    return removeChannelMember(this.ports, workspaceId, actorUserId, channelId, target);
  }

  members(workspaceId: string, actor: ChannelActor, channelId: string) {
    return channelMembers(this.ports, workspaceId, actor, channelId);
  }

  addMembers(
    workspaceId: string,
    actor: ChannelActor,
    channelId: string,
    input: { userIds: string[]; agentIds: string[] },
  ) {
    return addChannelMembers(this.ports, workspaceId, actor, channelId, input);
  }

  executeMentionActions(
    workspaceId: string,
    userId: string,
    action: "notify" | "add",
    resolutionIds: readonly string[],
  ) {
    return executeMentionActions(this.ports, workspaceId, userId, action, resolutionIds);
  }

  open(
    workspaceId: string,
    userId: string,
    channelId: string,
    page?: { beforeSequence?: number; afterSequence?: number; limit?: number },
  ) {
    return openChannel(this.ports, workspaceId, userId, channelId, page);
  }

  mentionDirectory(workspaceId: string, userId: string, channelId: string) {
    return mentionDirectory(this.ports, workspaceId, userId, channelId);
  }

  mentionOutsiders(workspaceId: string, userId: string, channelId: string) {
    return mentionOutsiders(this.ports, workspaceId, userId, channelId);
  }

  updates(
    workspaceId: string,
    userId: string,
    channelId: string,
    afterSequence: number,
    afterReplySequence?: number,
  ) {
    return channelUpdates(
      this.ports,
      workspaceId,
      userId,
      channelId,
      afterSequence,
      afterReplySequence,
    );
  }

  async send(input: Parameters<typeof sendChannel>[1]) {
    return sendChannel(
      {
        db: this.db,
        idempotency: this.idempotency,
        notifications: this.notifications,
        realtime: this.realtime,
        publisher: this.publisher,
      },
      input,
    );
  }

  /**
   * The browser's own emoji reaction on a channel message: the visibility scope of the other
   * per-message writes here, and the shared toggle requires active membership, so a reader who
   * never joined cannot react.
   */
  async toggleUserReaction(
    workspaceId: string,
    userId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ) {
    await memberChannel(this.db, workspaceId, userId, channelId);
    return toggleUserMessageReaction(this.db, this.realtime, {
      workspaceId,
      conversationId: channelId,
      userId,
      messageId,
      emoji,
      active,
    });
  }

  /**
   * Advances the human member's top-level read cursor. Monotone and clamped to the
   * conversation's current maximum sequence: a stale client cannot move the boundary backwards,
   * and an over-eager client cannot push it past the conversation (which would swallow future
   * messages into "already read").
   */
  async markRead(workspaceId: string, userId: string, channelId: string, throughSequence: number) {
    await markPublicChannelRead({
      db: this.db,
      realtime: this.realtime,
      authorize: () => memberChannel(this.db, workspaceId, userId, channelId),
      workspaceId,
      userId,
      conversationId: channelId,
      throughSequence,
    });
  }
}
