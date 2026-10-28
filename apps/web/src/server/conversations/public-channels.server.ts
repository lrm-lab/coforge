import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import { recordThreadCreatedByReply } from "#src/server/app-notifications/channel-events.server";
import { userUploadedAttachmentWhere } from "#src/server/attachments/message-attachments.server";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import type { BulkFileRemoval } from "#src/server/files/file-storage.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import { memberChannel, type ChannelActor, type PublicChannelPorts } from "./channel-access.server";
import { channelAgentRecipients } from "./channel-agent-recipients.server";
import { changeChannelCoordinator } from "./channel-coordination.server";
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
  enrollThreadReplyFollowers,
  markThreadReadForUser,
  setAgentThreadFollowed,
  setUserThreadFollowed,
  threadFollowingAgents,
  unfollowAgentFromThread,
} from "./channel-threads.server";
import { lockConversation } from "./conversation-lock.server";
import { browserMessageFields } from "./conversation-history.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { MentionDeliveryIssuer } from "./mention-deliveries.server";
import { deliveryMentionsAgent } from "./mentions.server";
import { channelMentionTargets, storeMessageBody } from "./message-references.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import {
  pendingMentionActionsForMessage,
  recordPendingMentionActions,
} from "./pending-mention-actions.server";
import { getMessageRequestIdempotency } from "./redis-message-request-idempotency.server";
import { agentMessageSender } from "./sender-display.server";
import type { SentMessageHook } from "./sent-message-hook.server";
import { unresolvedMentionHandles } from "./unresolved-mentions.server";
import { toggleUserMessageReaction } from "./user-message-reactions.server";

/**
 * Workspace-visible history with per-Agent notification preferences. The facade every caller
 * holds: each operation lives in the channel module that owns it (`channel-*.server.ts`), and
 * this class hands it the ports it was built with. Sending stays here.
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

  async send(input: {
    workspaceId: string;
    userId: string;
    channelId: string;
    idempotencyKey: string;
    body: string;
    attachmentIds?: string[];
    threadRootId?: string;
    /** Members the sender named by id (the composer's picks), beside the `@handle`s in `body`. */
    mentions?: readonly MentionSelectorInput[];
    /** Runs inside the send's transaction once the message and its uploads are written. */
    withinSend?: SentMessageHook;
  }) {
    const { workspaceId, userId, channelId, idempotencyKey, attachmentIds, threadRootId } = input;
    // This key is also the daemon delivery's request_id. A missing one is omitted on the wire
    // and the daemon drops the frame, so the Agent never sees the message.
    if (!idempotencyKey?.trim()) throw new AppError("INVALID_INPUT");
    const channel = await memberChannel(this.db, workspaceId, userId, channelId);
    if (channel.archivedAt) throw new AppError("CONFLICT");
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    const body = input.body.trim();
    // Postgres `message.body` is unbounded text. The browser composer stays at 8_000
    // (`sendConversationMessageInputSchema`); this path also accepts an eval prompt or an
    // Agent channel reply past that, which otherwise throws and kills the eval runner.
    if (!body || body.length > 64_000) throw new AppError("INVALID_INPUT");
    let created = false;
    const saved = await (this.idempotency ?? getMessageRequestIdempotency()).execute(
      { workspaceId, senderKind: "user", senderId: userId, idempotencyKey },
      () =>
        this.db.$transaction(async (tx) => {
          await lockConversation(tx, channelId);
          const root = threadRootId
            ? await tx.message.findFirst({
                where: { id: threadRootId, conversationId: channelId },
                select: { id: true, threadRootId: true, senderMemberId: true },
              })
            : undefined;
          if (threadRootId && !root)
            throw new AgentMessageValidationError("message anchor not found in this conversation");
          if (root?.threadRootId)
            throw new AgentMessageValidationError("thread root must be a top-level message");
          const latest = await tx.message.findFirst({
            where: { conversationId: channelId },
            orderBy: { sequence: "desc" },
          });
          // Validated before the message exists, then linked (messageId + position) once it does.
          const requestedAttachmentIds = attachmentIds ?? [];
          const availableAttachments = requestedAttachmentIds.length
            ? await tx.attachment.findMany({
                where: {
                  id: { in: [...new Set(requestedAttachmentIds)] },
                  conversationId: channelId,
                  workspaceId,
                  ...userUploadedAttachmentWhere(userId),
                  messageId: null,
                },
                select: { id: true },
              })
            : [];
          const availableAttachmentIds = new Set(
            availableAttachments.map((attachment) => attachment.id),
          );
          const attachmentRowIds = requestedAttachmentIds.map((attachmentId) => {
            if (!availableAttachmentIds.has(attachmentId)) throw new AppError("ACCESS_DENIED");
            return attachmentId;
          });
          // Resolve @mentions against the channel's active members they name. The stored body keeps
          // each resolved mention as an embedded-UUID token (`<@human:…>`/`<@agent:…>`,
          // Slack-style) and every resolved mention becomes a MessageMention row in the same
          // transaction, so renders and delivery never re-parse prose. Task references
          // (`task #68` → `<@task:68>`), channel references (`#product` →
          // `<@channel:uuid:product>`) and thread references (`#product:abcdef12` →
          // `<@thread:uuid:uuid:product>`) are resolved in the same pass: the server decides what
          // names a real task, channel or thread, and anything else stays ordinary text.
          const stored = await storeMessageBody(
            tx,
            { workspaceId, conversationId: channelId },
            body,
            {
              targets: (handles) =>
                channelMentionTargets(tx, { workspaceId, conversationId: channelId }, handles),
              bindings: input.mentions,
            },
          );
          if (root)
            await enrollThreadReplyFollowers(tx, {
              workspaceId,
              conversationId: channelId,
              root,
              participantMemberIds: [member.id, ...stored.mentions.map((mention) => mention.key)],
            });
          const recipients = await channelAgentRecipients(tx, {
            conversationId: channelId,
            threadRootId: root?.id,
            mentions: stored.mentions,
          });
          const sequence = (latest?.sequence ?? 0) + 1;
          const message = await tx.message.create({
            data: {
              workspaceId,
              conversationId: channelId,
              senderMemberId: member.id,
              threadRootId: root?.id,
              body: stored.body,
              sequence,
              mentions: stored.mentions.length
                ? {
                    create: stored.mentions.map((mention) => ({
                      memberId: mention.key,
                      workspaceId,
                      kind: mention.type,
                      actorId: mention.id,
                      handle: mention.handle,
                    })),
                  }
                : undefined,
              deliveries: {
                create: recipients.map((agentId) => ({
                  workspaceId,
                  conversationId: channelId,
                  agentId,
                  sequence,
                })),
              },
            },
          });
          if (root)
            await recordThreadCreatedByReply(tx, {
              workspaceId,
              channelId,
              threadRootId: root.id,
              messageId: message.id,
            });
          // A mention of someone outside the channel reached nobody; the sender may still act on it.
          await recordPendingMentionActions(tx, {
            id: message.id,
            workspaceId,
            conversationId: channelId,
            senderMemberId: member.id,
            body: stored.body,
            createdAt: message.createdAt,
          });
          await Promise.all(
            attachmentRowIds.map((id, position) =>
              tx.attachment.update({
                where: { id },
                data: { messageId: message.id, position },
              }),
            ),
          );
          await input.withinSend?.(tx, {
            id: message.id,
            conversationId: channelId,
            workspaceId,
            body: stored.body,
            senderMemberId: member.id,
            threadRootId: root?.id ?? null,
          });
          created = true;
          return {
            ...message,
            target: `#${channel.channelName}${root ? `:${root.id}` : ""}`,
            // Never read back: only `saved.id` is used below (the post-transaction reload via
            // browserMessageFields is the real attachments source). Present only to satisfy
            // the shared idempotency-cache value's "always present" contract.
            attachments: [] as {
              id: string;
              fileName: string;
              contentType: string;
              sizeBytes: number;
            }[],
          };
        }),
    );
    // Reuse persisted delivery identities on retries; never recompute recipients after mute changes.
    const message = await this.db.message.findFirstOrThrow({
      where: {
        id: saved.id,
        conversationId: channelId,
        senderMemberId: member.id,
      },
      select: {
        ...browserMessageFields,
        // Wider than browserMessageFields' sender: this reload alone feeds
        // `agentMessageSender` below, which needs the sender's description too.
        sender: {
          select: {
            agentId: true,
            agent: {
              select: { name: true, displayName: true, deletedAt: true, description: true },
            },
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarObjectKey: true,
                description: true,
              },
            },
          },
        },
        deliveries: {
          select: { deliveryId: true, agentId: true, agent: { select: { computerId: true } } },
        },
      },
    });
    if (created) await this.notifications?.notifyMessage(message.id);
    if (this.realtime) {
      try {
        await this.realtime.messageAvailable({
          conversationId: channelId,
          messageId: message.id,
          sequence: message.sequence,
          workspaceId,
          threadRootId: message.threadRootId ?? undefined,
          idempotencyKey,
          // Only a person sends here; an Agent's channel message goes through `SendDirectMessage`.
          senderUserId: userId,
        });
      } catch {
        // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
      }
    }
    // Every Agent's push goes out at once; a failure still rejects the send. The encoder reads the
    // stored tokens back as text for the Agent.
    const publisher = this.publisher ?? createCentrifugoServerApi();
    // Routed through the shared projection rather than two non-null assertions on
    // `sender.user`, which broke for an Agent-authored channel delivery.
    const sender = agentMessageSender(message.sender);
    const pushed = await new AgentDeliveryPublisher(
      publisher,
      new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(this.db)),
    ).publish(
      workspaceId,
      message.deliveries.map((delivery) => ({
        computerId: delivery.agent.computerId,
        requestId: idempotencyKey,
        conversationId: channelId,
        agentId: delivery.agentId,
        messageId: message.id,
        deliveryId: delivery.deliveryId,
        sequence: message.sequence,
        createdAtMs: message.createdAt.getTime(),
        body: message.body,
        mentions: message.mentions,
        target: `#${channel.channelName}${message.threadRootId ? `:${message.threadRootId}` : ""}`,
        latestSenderKind: sender.kind,
        latestSenderHandle: sender.handle,
        latestSenderDescription: sender.description,
        mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
      })),
    );
    const failed = pushed.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    // Read from the stored body, so an idempotent replay reads the same `@handle`s.
    const unresolved = await unresolvedMentionHandles(
      this.db,
      workspaceId,
      { userId },
      message.body,
    );
    const pendingMentionActions = await pendingMentionActionsForMessage(
      this.db,
      {
        id: message.id,
        workspaceId,
        conversationId: channelId,
        senderMemberId: member.id,
        body: message.body,
      },
      { archived: channel.archivedAt !== null, name: channel.channelName! },
    );
    return { ...message, unresolvedMentionHandles: unresolved, pendingMentionActions };
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
