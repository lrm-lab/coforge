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
  resolveMessage,
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
import { deliveryTarget } from "./direct-conversation-agent-message.server";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import {
  assertAgentDmWithinLimits,
  noteAgentDmLimit,
} from "#src/server/conversations/agent-dm-limits.server";
import { receiveDeliveryAck } from "./delivery-ack.repositories.server";
import { humanUsernameTarget } from "./agent-peer-target.server";
import {
  findUserAgentConversation,
  getOrCreateUserAgentConversation,
  openUserAgentConversation,
} from "./user-agent-direct.repositories.server";
import {
  humanRef,
  dmParentTarget,
  getOrCreateAgentPeerConversation,
  openDirectPeerConversation,
  liveAgentPeer,
  peerSeatTarget,
} from "./agent-peer-direct.repositories.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { isAppBot } from "#src/features/agents/agent-system-kind";
import { isAgentPeerDirectKey } from "#src/features/conversations/direct-key";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { userIdOfUsernameTarget } from "./public-user-target.repositories.server";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { channelAgentRecipients } from "#src/server/conversations/channel-agent-recipients.server";
import { enrollThreadReplyFollowers } from "#src/server/conversations/channel-threads.server";
import { getAgentChannel } from "#src/server/conversations/channel-access.server";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";
import {
  channelMentionTargets,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";
import { recordThreadCreatedByReply } from "#src/server/app-notifications/channel-events.server";
import { recordPendingMentionActions } from "#src/server/conversations/pending-mention-actions.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  attachmentView,
  ATTACHMENT_VIEW_SELECT,
  type AttachmentViewRow,
} from "#src/server/attachments/attachment-view.server";
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

/**
 * Next sequence for a conversation; holds the conversation row lock until the transaction ends.
 * Exported so other message-anchored writers (e.g. `ActionCards.prepare`) serialize through the
 * same lock instead of reimplementing sequence allocation.
 */
export async function allocateSequence(tx: Prisma.TransactionClient, conversationId: string) {
  await lockConversation(tx, conversationId);
  const last = await tx.message.findFirst({
    where: { conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return (last?.sequence ?? 0) + 1;
}

export class PrismaDirectConversationRepository implements DirectConversationRepository {
  /** Channel lookups this instance has made, kept only when it serves a single request. */
  readonly #agentChannels?: Map<string, Promise<{ id: string }>>;

  /**
   * Cache channel lookups only for this request, sharing send freshness/Memory reads.
   * Longer caching could retain revoked membership; the send rechecks it before writing.
   */
  constructor(
    private readonly db: PrismaClient,
    { oneRequest = false }: { oneRequest?: boolean } = {},
    private readonly realtime?: ReactionPort & ConversationReadRealtimePort,
  ) {
    if (oneRequest) this.#agentChannels = new Map();
  }

  /** What the operations in the `agent-*` and `user-direct-reads` modules run on; its channel
   * lookup is this instance's, so they share the one-request cache. */
  get #ports(): DirectConversationPorts {
    return {
      db: this.db,
      realtime: this.realtime,
      getAgentChannel: (workspaceId, agentId, target) =>
        this.getAgentChannel(workspaceId, agentId, target),
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

  private resolveMessage(conversationId: string, anchor: string, rootOnly = false) {
    return resolveMessage(this.#ports, conversationId, anchor, rootOnly);
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
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        workspaceId: true,
        members: {
          select: {
            id: true,
            userId: true,
            agentId: true,
            user: { select: { username: true, description: true } },
            agent: {
              select: {
                name: true,
                computerId: true,
                ownerId: true,
                visibility: true,
                systemKind: true,
              },
            },
          },
        },
      },
    });
    if (!conversation) throw new Error("conversation not found");
    const sender = conversation.members.find(
      (member) => member.id === senderMemberId && member.userId === senderUserId,
    );
    const agents = conversation.members.filter((member) => member.agentId !== null);
    if (!sender) throw new Error("sender is not a conversation member");
    if (conversation.members.length !== 2 || agents.length !== 1 || !agents[0]?.agentId)
      throw new Error("only User-Agent direct conversations are supported");
    // A private Agent's direct conversation stays scoped to its own creator: once it
    // goes private, an existing DM held by anyone else stops accepting new messages, though its
    // history stays readable.
    if (agents[0].agent && !canDirectMessageAgent(senderUserId, agents[0].agent))
      throw new AppError("AGENT_DM_RESTRICTED");
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
    const message = await this.db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      // Validated before the message exists, then linked (messageId + position) once it does; see
      // the multi-attachment transaction pattern shared by every send path in this file.
      const requestedAttachmentIds = attachmentIds ?? [];
      const availableAttachments = requestedAttachmentIds.length
        ? await tx.attachment.findMany({
            where: {
              id: { in: [...new Set(requestedAttachmentIds)] },
              conversationId,
              workspaceId: conversation.workspaceId,
              uploaderId: senderUserId,
              messageId: null,
            },
            select: ATTACHMENT_VIEW_SELECT,
          })
        : [];
      const attachmentsById = new Map(
        availableAttachments.map((attachment) => [attachment.id, attachment]),
      );
      const attachments: AttachmentViewRow[] = [];
      for (const attachmentId of requestedAttachmentIds) {
        const attachment = attachmentsById.get(attachmentId);
        if (!attachment) throw new Error("attachment is not available for this message");
        attachments.push(attachment);
      }
      // A DM keeps plain `@handle` text (no mention targets), but its task and channel
      // references are stored as tokens like every other conversation's.
      const stored = await storeMessageBody(
        tx,
        { workspaceId: conversation.workspaceId, conversationId },
        body,
        { targets: [] },
      );
      const created = await tx.message.create({
        data: {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderMemberId,
          threadRootId: root?.id,
          body: stored.body,
          sequence,
          deliveries: {
            create: {
              workspaceId: conversation.workspaceId,
              conversationId,
              agentId: agents[0]!.agentId!,
              sequence,
            },
          },
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          sequence: true,
          // Carried so the browser signal can exclude thread replies from channel unread.
          threadRootId: true,
          deliveries: { select: { deliveryId: true } },
        },
      });
      await Promise.all(
        attachments.map((attachment, position) =>
          tx.attachment.update({
            where: { id: attachment.id },
            data: { messageId: created.id, position },
          }),
        ),
      );
      await withinSend?.(tx, {
        id: created.id,
        conversationId,
        workspaceId: conversation.workspaceId,
        body: created.body,
        senderMemberId,
        threadRootId: created.threadRootId,
      });
      return { ...created, attachments };
    });
    const senderIdentity = agentMessageSender({ agentId: null, agent: null, user: sender.user });
    const senderRef = await humanRef(
      this.db,
      conversation.workspaceId,
      agents[0].agentId,
      senderIdentity.handle,
    );
    return {
      ...message,
      deliveryId: message.deliveries[0]!.deliveryId,
      workspaceId: conversation.workspaceId,
      agentId: agents[0].agentId,
      computerId: agents[0].agent?.computerId ?? undefined,
      appBot: isAppBot(agents[0].agent),
      target: `@${agents[0].agent?.name ?? "unknown"}`,
      latestSenderKind: senderIdentity.kind,
      latestSenderHandle: senderIdentity.handle,
      latestSenderDescription: senderIdentity.description,
      deliveryTarget: deliveryTarget(senderRef, root?.id),
      attachments: message.attachments.map((attachment) => attachmentView(attachment)),
    };
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
  ) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true, channelName: true, archivedAt: true, directKey: true },
    });
    if (!conversation) throw new Error("conversation scope is not authorized");
    const agentPeer =
      !conversation.channelName && isAgentPeerDirectKey(conversation.directKey ?? "");
    if (conversation.channelName && conversation.archivedAt) throw new AppError("CONFLICT");
    // A DM's two members; in a channel, not the whole roster (#general holds the whole
    // Workspace) but the sending Agent's own row and the members its `--mention` bindings name.
    // The body's plain `@handle`s load their members in `storeMessageBody` below.
    const members = await this.db.conversationMember.findMany({
      where: {
        conversationId,
        ...(conversation.channelName && {
          OR: [
            {
              agentId: {
                in: [
                  agentId,
                  ...(mentions ?? []).flatMap((m) => (m.type === "agent" ? [m.id] : [])),
                ],
              },
            },
            {
              userId: { in: (mentions ?? []).flatMap((m) => (m.type === "user" ? [m.id] : [])) },
            },
          ],
        }),
      },
      include: {
        agent: MESSAGE_SENDER_SELECT.select.agent,
        user: MESSAGE_SENDER_SELECT.select.user,
      },
    });
    let sender = members.find((m) => m.agentId === agentId && !m.leftAt);
    const user = members.find((m) => m.userId && !m.leftAt);
    // Clear leftAt for live Agent DMs: visibility changes never leave DMs, and deleted Agents
    // have revoked keys. Preserve channel soft-leaves, which represent intentional removals.
    if (!sender && !conversation.channelName) {
      const softLeft = members.find((m) => m.agentId === agentId && m.leftAt);
      if (softLeft) {
        const self = await this.db.agent.findUnique({
          where: { id: agentId },
          select: { deletedAt: true },
        });
        if (self && !self.deletedAt) {
          await this.db.conversationMember.update({
            where: { id: softLeft.id },
            data: { leftAt: null },
          });
          sender = { ...softLeft, leftAt: null };
        }
      }
    }
    // Between two Agents the other is the recipient, while live.
    const peer = agentPeer && (await liveAgentPeer(this.db, conversation, agentId));
    if (!sender || (!conversation.channelName && !(agentPeer ? peer : user)))
      throw new AgentSendRejectedError(403, "agent is not a conversation member");
    // A private Agent's own outbound DM is just as read-only as the human side of it
    // ("neither side can send"). Channels are unaffected — a private Agent is never a channel
    // member in the first place, so this only ever narrows the direct-conversation case.
    if (!conversation.channelName && user) {
      const self = await this.db.agent.findUnique({
        where: { id: agentId },
        select: { ownerId: true, visibility: true },
      });
      if (self && !canDirectMessageAgent(user.userId!, self))
        throw new AgentSendRejectedError(
          403,
          "this Agent is private; the direct message is read-only",
        );
    }
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
    const messageSelect = {
      id: true,
      body: true,
      createdAt: true,
      sequence: true,
      // Carried so the browser signal can exclude thread replies from channel unread.
      threadRootId: true,
      mentions: { select: { kind: true, actorId: true, handle: true } },
      deliveries: {
        select: {
          deliveryId: true,
          agentId: true,
          agent: { select: { computerId: true } },
        },
      },
    } satisfies Prisma.MessageSelect;
    const result = await this.db.$transaction(async (tx) => {
      let hint;
      if (memoryHintId) {
        await tx.$queryRaw`SELECT id FROM memory_hint_records
          WHERE workspace_id = ${conversation.workspaceId}::uuid AND id = ${memoryHintId}::uuid FOR UPDATE`;
        hint = await tx.memoryHintRecord.findUniqueOrThrow({
          where: { workspaceId_id: { workspaceId: conversation.workspaceId, id: memoryHintId } },
        });
        if (hint.memoryAgentId !== agentId || hint.conversationId !== conversationId)
          throw new AgentSendRejectedError(403, "Memory Hint delivery scope mismatch");
        if (hint.messageId) {
          const existing = await tx.message.findUniqueOrThrow({
            where: { id: hint.messageId },
            select: messageSelect,
          });
          return { ...existing, attachments: [] };
        }
      }
      const sequence = await allocateSequence(tx, conversationId);
      if (peer)
        await assertAgentDmWithinLimits(tx, {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderAgentId: agentId,
        });
      // Require the sending Agent's own uploads before creating the message; link messageId
      // and position afterward in the same transaction.
      const requestedAttachmentIds = attachmentIds ?? [];
      const availableAttachments = requestedAttachmentIds.length
        ? await tx.attachment.findMany({
            where: {
              id: { in: [...new Set(requestedAttachmentIds)] },
              conversationId,
              workspaceId: conversation.workspaceId,
              uploaderAgentId: agentId,
              messageId: null,
            },
            select: { id: true, fileName: true, contentType: true, sizeBytes: true },
          })
        : [];
      const attachmentsById = new Map(
        availableAttachments.map((attachment) => [attachment.id, attachment]),
      );
      const attachments: {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
      }[] = [];
      for (const attachmentId of requestedAttachmentIds) {
        const attachment = attachmentsById.get(attachmentId);
        if (!attachment)
          throw new AgentSendRejectedError(403, "attachment is not available for this message");
        attachments.push(attachment);
      }
      const mentionedMemberIds: string[] = [];
      if (mentions?.length) {
        for (const mention of mentions) {
          const match = members.find((member) =>
            mention.type === "user"
              ? member.userId === mention.id && member.user?.username === mention.name
              : member.agentId === mention.id && member.agent?.name === mention.name,
          );
          if (!match)
            throw new AgentSendRejectedError(
              400,
              `mention binding does not match a conversation member: @${mention.name}`,
            );
          mentionedMemberIds.push(match.id);
        }
      }
      // Channel member mentions (structured or plain) become <@kind:uuid> plus MessageMention;
      // DM @handles stay plain. Resolved task/channel/thread references become stored tokens
      // in either conversation kind, rendered as chips without reparsing prose.
      const stored = await storeMessageBody(
        tx,
        { workspaceId: conversation.workspaceId, conversationId },
        body,
        {
          targets: conversation.channelName
            ? (handles) =>
                channelMentionTargets(
                  tx,
                  { workspaceId: conversation.workspaceId, conversationId },
                  handles,
                )
            : [],
          bindings: mentions ?? [],
        },
      );
      // Everyone the reply mentions follows the thread: exactly the members its stored mention
      // rows name (each mention's key is the member id), plus every `--mention` binding.
      if (conversation.channelName && root)
        await enrollThreadReplyFollowers(tx, {
          workspaceId: conversation.workspaceId,
          conversationId,
          root,
          participantMemberIds: [
            sender.id,
            ...stored.mentions.map((mention) => mention.key),
            ...mentionedMemberIds,
          ],
        });
      // A person's DM wakes no Agent (its only Agent is the sender); a DM between two Agents wakes
      // the other, whatever its state.
      const recipients = conversation.channelName
        ? await channelAgentRecipients(tx, {
            conversationId,
            threadRootId: root?.id,
            mentions: stored.mentions,
            senderAgentId: agentId,
          })
        : peer
          ? [peer.id]
          : [];
      if (hint && !recipients.includes(hint.targetAgentId))
        throw new AgentSendRejectedError(403, "Memory Hint target delivery is missing");
      const created = await tx.message.create({
        data: {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderMemberId: sender.id,
          threadRootId: root?.id,
          body: stored.body,
          sequence,
          mentions: stored.mentions.length
            ? {
                create: stored.mentions.map((mention) => ({
                  memberId: mention.key,
                  workspaceId: conversation.workspaceId,
                  kind: mention.type,
                  actorId: mention.id,
                  handle: mention.handle,
                })),
              }
            : undefined,
          deliveries: {
            create: recipients.map((wakeAgentId) => ({
              workspaceId: conversation.workspaceId,
              conversationId,
              agentId: wakeAgentId,
              sequence,
            })),
          },
        },
        select: messageSelect,
      });
      if (hint) {
        const deliveredAt = new Date();
        await tx.memoryHintRecord.update({
          where: { id: hint.id },
          data: {
            messageId: created.id,
            deliveredAt,
            expiresAt: new Date(deliveredAt.getTime() + hint.ttlMilliseconds),
          },
        });
      }
      // A channel mention of someone outside the channel reached nobody; the sending Agent may
      // still act on it. A DM stores every `@handle` as text, so it records nothing.
      if (conversation.channelName) {
        await recordPendingMentionActions(tx, {
          id: created.id,
          workspaceId: conversation.workspaceId,
          conversationId,
          senderMemberId: sender.id,
          body: stored.body,
          createdAt: created.createdAt,
        });
        if (root)
          await recordThreadCreatedByReply(tx, {
            workspaceId: conversation.workspaceId,
            channelId: conversationId,
            threadRootId: root.id,
            messageId: created.id,
          });
      }
      await Promise.all(
        attachments.map((attachment, position) =>
          tx.attachment.update({
            where: { id: attachment.id },
            data: { messageId: created.id, position },
          }),
        ),
      );
      return { ...created, attachments };
    });
    // Never falls back to the internal Agent id: a missing name fails loudly.
    const senderIdentity = agentMessageSender({ agentId, agent: sender.agent, user: null });
    return {
      ...result,
      // Agent-originated messages must never be enqueued back to the sender.
      deliveryId: undefined,
      workspaceId: conversation.workspaceId,
      agentId,
      latestSenderKind: senderIdentity.kind,
      latestSenderHandle: senderIdentity.handle,
      latestSenderDescription: senderIdentity.description,
      deliveries: result.deliveries.map((delivery) => ({
        deliveryId: delivery.deliveryId,
        agentId: delivery.agentId,
        computerId: delivery.agent.computerId,
      })),
      target: conversation.channelName
        ? deliveryTarget(`#${conversation.channelName}`, root?.id)
        : peer
          ? deliveryTarget(await peerSeatTarget(this.db, conversation, members, peer.id), root?.id)
          : "",
      // Agent-facing shape: metadata only; the object key never leaves the backend (never
      // selected above, unlike the browser-facing `browserMessageFields`).
      attachments: result.attachments,
    };
  }
}
