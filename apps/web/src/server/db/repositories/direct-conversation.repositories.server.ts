import {
  advanceAgentReadThrough,
  agentMentionReport,
  committedAgentMentionReport,
  readMessagesPage,
} from "./agent-message-reads.repositories.server";
import {
  readAgentRecoveryContext,
  readPendingAgentDeliveries,
} from "./agent-recovery.repositories.server";
import { drainAgentEvents } from "./agent-event-drain.repositories.server";
import { agentTargetFreshness } from "./agent-target-freshness.repositories.server";
import {
  resolveAgentMessage,
  resolveAgentReplyTarget,
  resolveAgentSendTarget,
  resolveAgentTarget,
  setAgentChannelMuted,
  setAgentMessageReaction,
  setAgentThreadFollowed,
  type DirectConversationPorts,
} from "./agent-targets.repositories.server";
import {
  markReadForUser,
  markThreadReadForUser,
  openConversationForUser,
  updatesSince,
} from "./user-direct-reads.repositories.server";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import { noteAgentDmLimit } from "#src/server/conversations/agent-dm-limits.server";
import { receiveDeliveryAck } from "./delivery-ack.repositories.server";
import { humanUsernameTarget } from "./agent-peer-target.server";
import {
  findUserAgentConversation,
  getOrCreateUserAgentConversation,
  openUserAgentConversation,
} from "./user-agent-direct.repositories.server";
import {
  dmParentTarget,
  getOrCreateAgentPeerConversation,
  openDirectPeerConversation,
} from "./agent-peer-direct.repositories.server";
import { type PrismaClient } from "#src/generated/prisma/client";
import { userIdOfUsernameTarget } from "./public-user-target.repositories.server";
import { sendMessage } from "./direct-message-send.repositories.server";
import { sendAgentMessage } from "./direct-message-sends.repositories.server";
import {
  getAgentChannel,
  getAgentSendChannel,
} from "#src/server/conversations/channel-access.server";
import { type ReactionPort } from "#src/server/conversations/reaction-write.server";
import type { ResolvedAgentTarget } from "./resolved-agent-target.server";
import { type ConversationReadRealtimePort } from "./agent-read-groups.repositories.server";
import {
  searchAgentMessagePage,
  type AgentMessageSearchOptions,
} from "./agent-message-search.repositories.server";
import type {
  AgentMentionBinding,
  AgentMentionReport,
  DirectConversationPageOptions,
  DirectConversationRepository,
  HistoryWindow,
} from "./direct-conversation-types.server";

export type {
  AgentFacingSender,
  AgentMentionBinding,
  AgentMentionReport,
  AgentRecoveryContext,
  AttachmentMetadata,
  DirectConversationPage,
  DirectConversationPageOptions,
  DirectConversationRepository,
  HistoryWindow,
  LatestSenderFields,
  PendingAgentDelivery,
} from "./direct-conversation-types.server";

export class PrismaDirectConversationRepository implements DirectConversationRepository {
  /** Channel lookups this instance has made, kept only when it serves a single request. */
  readonly #agentChannels?: Map<string, Promise<{ id: string }>>;
  /** Send-path channel lookups, kept for a single request beside `#agentChannels`. */
  readonly #agentSendChannels?: Map<
    string,
    Promise<{ id: string; channelName?: string | null; needsJoin: boolean }>
  >;

  /**
   * Cache channel lookups only for this request, sharing send freshness/Memory reads.
   * Longer caching could retain revoked membership; the send rechecks it before writing.
   */
  constructor(
    private readonly db: PrismaClient,
    { oneRequest = false }: { oneRequest?: boolean } = {},
    private readonly realtime?: ReactionPort & ConversationReadRealtimePort,
  ) {
    if (oneRequest) {
      this.#agentChannels = new Map();
      this.#agentSendChannels = new Map();
    }
  }

  /** What the operations in the `agent-*` and `user-direct-reads` modules run on; its channel
   * lookup is this instance's, so they share the one-request cache. */
  get #ports(): DirectConversationPorts {
    return {
      db: this.db,
      realtime: this.realtime,
      getAgentChannel: (workspaceId, agentId, target) =>
        this.getAgentChannel(workspaceId, agentId, target),
      getAgentSendChannel: (workspaceId, agentId, target) =>
        this.getAgentSendChannel(workspaceId, agentId, target),
      findUserAgentConversation: (workspaceId, userId, agentId) =>
        this.findUserAgentConversation(workspaceId, userId, agentId),
      getOrCreateUserAgent: (workspaceId, userId, agentId) =>
        this.getOrCreateUserAgent(workspaceId, userId, agentId),
      resolveAgentTarget: (workspaceId, agentId, target) =>
        this.resolveAgentTarget(workspaceId, agentId, target),
    };
  }

  async userIdForUsername(target: string) {
    return userIdOfUsernameTarget(this.db, humanUsernameTarget(dmParentTarget(target)));
  }

  getAgentChannel(workspaceId: string, agentId: string, target: string) {
    const lookups = this.#agentChannels;
    if (!lookups) return getAgentChannel(this.db, workspaceId, agentId, target);
    const key = `${workspaceId}:${agentId}:${target}`;
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = getAgentChannel(this.db, workspaceId, agentId, target);
      lookups.set(key, lookup);
    }
    return lookup;
  }

  /** The send path's channel lookup, shared by the send's Memory check, freshness check and the
   * send itself. Cached like `getAgentChannel`: the send's transaction rechecks what it writes. */
  getAgentSendChannel(workspaceId: string, agentId: string, target: string) {
    const lookups = this.#agentSendChannels;
    if (!lookups) return getAgentSendChannel(this.db, workspaceId, agentId, target);
    const key = `${workspaceId}:${agentId}:${target}`;
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = getAgentSendChannel(this.db, workspaceId, agentId, target);
      lookups.set(key, lookup);
    }
    return lookup;
  }

  async setAgentChannelMuted(workspaceId: string, agentId: string, target: string, muted: boolean) {
    return setAgentChannelMuted(this.#ports, workspaceId, agentId, target, muted);
  }

  async setAgentThreadFollowed(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
  ) {
    return setAgentThreadFollowed(this.#ports, workspaceId, agentId, target, followed);
  }

  async resolveAgentTarget(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<ResolvedAgentTarget> {
    return resolveAgentTarget(this.#ports, workspaceId, agentId, target);
  }

  resolveAgentSendTarget(workspaceId: string, agentId: string, target: string) {
    return resolveAgentSendTarget(this.#ports, workspaceId, agentId, target);
  }

  async resolveAgentReplyTarget(workspaceId: string, agentId: string, target: string) {
    return resolveAgentReplyTarget(this.#ports, workspaceId, agentId, target);
  }

  searchMessages(workspaceId: string, agentId: string, options: AgentMessageSearchOptions) {
    return searchAgentMessagePage(this.db, workspaceId, agentId, options, (target) =>
      this.resolveAgentTarget(workspaceId, agentId, target),
    );
  }

  async resolveAgentMessage(workspaceId: string, agentId: string, anchor: string) {
    return resolveAgentMessage(this.#ports, workspaceId, agentId, anchor);
  }

  async setAgentMessageReaction(
    workspaceId: string,
    agentId: string,
    anchor: string,
    emoji: string,
    active: boolean,
  ) {
    return setAgentMessageReaction(this.#ports, workspaceId, agentId, anchor, emoji, active);
  }

  /** Tells a conversation between Agents, once, that a limit stopped it. */
  noteAgentDmLimit(input: Parameters<typeof noteAgentDmLimit>[1]) {
    return noteAgentDmLimit(this.db, input);
  }

  /** The conversation a direct send names, started if need be, and who it is with. */
  openAgentDirect(workspaceId: string, agentId: string, parentTarget: string) {
    return openDirectPeerConversation(this.db, { workspaceId, agentId }, parentTarget, {
      user: (userId) => this.getOrCreateUserAgent(workspaceId, userId, agentId),
      agent: (peerId) => getOrCreateAgentPeerConversation(this.db, workspaceId, agentId, peerId),
    });
  }

  /** The person's DM with this Agent, started if need be. */
  getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
    return getOrCreateUserAgentConversation(this.db, workspaceId, userId, agentId);
  }

  /** The person's DM as they open it, and whether this open started it. */
  openUserAgent(workspaceId: string, userId: string, agentId: string) {
    return openUserAgentConversation(this.db, workspaceId, userId, agentId);
  }

  async findUserAgentConversation(workspaceId: string, userId: string, agentId: string) {
    return findUserAgentConversation(this.db, workspaceId, userId, agentId);
  }

  /** The ids a browser send needs, without reading any messages. */
  async memberForUser(workspaceId: string, userId: string, agentId: string) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const member = await this.db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
      select: { id: true },
    });
    return { conversationId: conversation.id, senderMemberId: member.id };
  }

  /** The viewer's DM with an Agent, started on first open, as `openConversationForUser` reads it. */
  async openForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    page: HistoryWindow = {},
  ) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const opened = await this.openConversationForUser(workspaceId, userId, conversation.id, page);
    if (opened.kind !== "agent") throw new Error("conversation scope is not authorized");
    return opened;
  }

  async openConversationForUser(
    workspaceId: string,
    userId: string,
    conversationId: string,
    page: HistoryWindow = {},
  ) {
    return openConversationForUser(this.#ports, workspaceId, userId, conversationId, page);
  }

  async updatesSince(
    workspaceId: string,
    conversationId: string,
    afterSequence: number,
    afterReplySequence?: number,
  ) {
    return updatesSince(
      this.#ports,
      workspaceId,
      conversationId,
      afterSequence,
      afterReplySequence,
    );
  }

  async markReadForUser(userId: string, conversationId: string, throughSequence: number) {
    return markReadForUser(this.#ports, userId, conversationId, throughSequence);
  }

  async markThreadReadForUser(
    workspaceId: string,
    userId: string,
    conversationId: string,
    rootMessageId: string,
    throughSequence: number,
  ) {
    return markThreadReadForUser(
      this.#ports,
      workspaceId,
      userId,
      conversationId,
      rootMessageId,
      throughSequence,
    );
  }

  async sendMessage(
    conversationId: string,
    senderMemberId: string,
    senderUserId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    withinSend?: SentMessageHook,
  ) {
    return sendMessage(
      this.#ports,
      conversationId,
      senderMemberId,
      senderUserId,
      body,
      attachmentIds,
      threadRootId,
      withinSend,
    );
  }

  receiveDeliveryAck(input: Parameters<typeof receiveDeliveryAck>[1]) {
    return receiveDeliveryAck(this.db, input);
  }

  async readPendingAgentDeliveries(
    workspaceId: string,
    agentId: string,
    select?: { deliveryIds: readonly string[]; orUnreceived?: boolean },
  ) {
    return readPendingAgentDeliveries(this.#ports, workspaceId, agentId, select);
  }

  async readMessages(
    workspaceId: string,
    agentId: string,
    target: string,
    page: DirectConversationPageOptions = {},
  ) {
    return (await this.readMessagesPage(workspaceId, agentId, target, page)).messages;
  }

  async readMessagesPage(
    workspaceId: string,
    agentId: string,
    target: string,
    page: DirectConversationPageOptions = {},
  ) {
    return readMessagesPage(this.#ports, workspaceId, agentId, target, page);
  }

  async readAgentRecoveryContext(workspaceId: string, agentId: string) {
    return readAgentRecoveryContext(this.#ports, workspaceId, agentId);
  }

  async drainAgentEvents(workspaceId: string, agentId: string, limit = 20, target?: string) {
    return drainAgentEvents(this.#ports, workspaceId, agentId, limit, target);
  }

  async agentTargetFreshness(workspaceId: string, agentId: string, target: string) {
    return agentTargetFreshness(this.#ports, workspaceId, agentId, target);
  }

  async advanceAgentReadThrough(
    workspaceId: string,
    agentId: string,
    target: string,
    seenUpToSequence: number,
  ): Promise<number> {
    return advanceAgentReadThrough(this.#ports, workspaceId, agentId, target, seenUpToSequence);
  }

  async agentMentionReport(
    workspaceId: string,
    agentId: string,
    message: { id: string; conversationId: string; body: string },
  ): Promise<AgentMentionReport> {
    return agentMentionReport(this.#ports, workspaceId, agentId, message);
  }

  async committedAgentMentionReport(
    workspaceId: string,
    agentId: string,
    messageId: string,
  ): Promise<AgentMentionReport> {
    return committedAgentMentionReport(this.#ports, workspaceId, agentId, messageId);
  }

  async sendAgentMessage(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    mentions?: readonly AgentMentionBinding[],
    memoryHintId?: string,
    joinChannel?: boolean,
  ) {
    return sendAgentMessage(
      this.#ports,
      conversationId,
      agentId,
      body,
      attachmentIds,
      threadRootId,
      mentions,
      memoryHintId,
      joinChannel,
    );
  }
}
