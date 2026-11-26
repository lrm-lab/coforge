import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { ForwardedMessage, MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { recordThreadCreatedByReply } from "#src/server/app-notifications/channel-events.server";
import {
  ATTACHMENT_VIEW_SELECT,
  type AttachmentViewRow,
} from "#src/server/attachments/attachment-view.server";
import { userUploadedAttachmentWhere } from "#src/server/attachments/message-attachments.server";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import { channelAgentRecipients } from "./channel-agent-recipients.server";
import { enrollThreadReplyFollowers } from "./channel-threads.server";
import { lockConversation } from "./conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { browserMessageFields } from "./browser-message-projection.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { MentionDeliveryIssuer } from "./mention-deliveries.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT, deliveryMentionsAgent } from "./mentions.server";
import {
  channelMentionTargets,
  storeMessageBody,
  writeMessageReferences,
} from "./message-references.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { pendingMentionActionsForMessage } from "./pending-mention-views.server";
import {
  recordPendingMentionActions,
  unboundMentionTargets,
} from "./pending-mention-action-recording.server";
import { getMessageRequestIdempotency } from "./redis-message-request-idempotency.server";
import { agentMessageSender } from "./sender-display.server";
import { taskReferenceViews } from "./task-reference-view.server";
import type { SentMessageHook } from "./sent-message-hook.server";
import { unresolvedMentionHandles } from "./unresolved-mentions.server";
import { requireUserMayPostInChannel } from "./channel-post-access.server";
import {
  announceMessageBestEffort,
  type AnnounceMessageSnapshot,
} from "./conversation-activity.server";
import { publishConcurrently } from "./concurrent-publication.server";

export type ChannelSendPorts = {
  db: PrismaClient;
  idempotency?: MessageRequestIdempotency;
  notifications?: MessageNotifier;
  realtime?: ConversationRealtime;
  publisher?: CentrifugoServerApi;
};

type CreatedAttachmentRow = AttachmentViewRow & {
  forwardPosition: number | null;
};

type CreatedChannelMessageState = {
  id: string;
  sequence: number;
  threadRootId: string | null;
  senderMemberId: string;
  body: string;
  createdAt: Date;
  attachments: CreatedAttachmentRow[];
  mentionCount: number;
  deliveryCount: number;
  recordedPendingActions: number;
};

const CHANNEL_SEND_RELOAD_SELECT = {
  ...browserMessageFields,
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
};

export async function sendChannel(
  ctx: ChannelSendPorts,
  input: {
    workspaceId: string;
    userId: string;
    channelId: string;
    idempotencyKey: string;
    body: string;
    attachmentIds?: string[];
    threadRootId?: string;
    mentions?: readonly MentionSelectorInput[];
    withinSend?: SentMessageHook;
    allowEmptyBody?: boolean;
    forwarded?: readonly ForwardedMessage[];
  },
) {
  const { workspaceId, userId, channelId, idempotencyKey, attachmentIds, threadRootId } = input;
  if (!idempotencyKey?.trim()) throw new AppError("INVALID_INPUT");
  const [accessResult, rootResult] = await Promise.allSettled([
    requireUserMayPostInChannel(ctx.db, workspaceId, userId, channelId),
    threadRootId
      ? ctx.db.message.findFirst({
          where: { id: threadRootId, conversationId: channelId },
          select: { id: true, threadRootId: true, senderMemberId: true },
        })
      : Promise.resolve(undefined),
  ]);
  if (accessResult.status === "rejected") throw accessResult.reason;
  const { channel, member } = accessResult.value;
  const body = input.body.trim();
  if ((!body && !input.allowEmptyBody) || body.length > 64_000) throw new AppError("INVALID_INPUT");
  if (rootResult.status === "rejected") throw rootResult.reason;
  const root = rootResult.value;
  if (threadRootId && !root)
    throw new AgentMessageValidationError("message anchor not found in this conversation");
  if (root?.threadRootId)
    throw new AgentMessageValidationError("thread root must be a top-level message");
  let created = false;
  let createdState: CreatedChannelMessageState | undefined;
  const saved = await (ctx.idempotency ?? getMessageRequestIdempotency()).execute(
    { workspaceId, senderKind: "user", senderId: userId, idempotencyKey },
    () =>
      ctx.db.$transaction(async (tx) => {
        await lockConversation(tx, channelId);
        const requestedAttachmentIds = attachmentIds ?? [];
        const attachmentRowIds = [...new Set(requestedAttachmentIds)];
        const availableAttachments = attachmentRowIds.length
          ? await tx.attachment.findMany({
              where: {
                id: { in: attachmentRowIds },
                conversationId: channelId,
                workspaceId,
                ...userUploadedAttachmentWhere(userId),
                messageId: null,
              },
              select: { ...ATTACHMENT_VIEW_SELECT, forwardPosition: true },
            })
          : [];
        const availableById = new Map(
          availableAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const missingAttachmentIds = attachmentRowIds.filter((id) => !availableById.has(id));
        if (missingAttachmentIds.length > 0) {
          throw new AppError("ATTACHMENTS_UNAVAILABLE", {
            details: { attachmentIds: missingAttachmentIds.join(",") },
          });
        }
        const stored = await storeMessageBody(
          tx,
          { workspaceId, conversationId: channelId, reader: { userId } },
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
        const sequence = await allocateSequence(tx, channelId);
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
            deliveries: recipients.length
              ? {
                  create: recipients.map((agentId) => ({
                    workspaceId,
                    conversationId: channelId,
                    agentId,
                    sequence,
                  })),
                }
              : undefined,
          },
        });
        await writeMessageReferences(
          tx,
          message,
          { conversationId: channelId, workspaceId },
          stored.references,
        );

        if (root)
          await recordThreadCreatedByReply(tx, {
            workspaceId,
            channelId,
            threadRootId: root.id,
            messageId: message.id,
          });
        const recordedPendingActions = await recordPendingMentionActions(
          tx,
          {
            id: message.id,
            workspaceId,
            conversationId: channelId,
            senderMemberId: member.id,
            body: stored.body,
            createdAt: message.createdAt,
          },
          unboundMentionTargets(input.mentions ?? [], stored.mentions),
        );
        for (const [position, id] of attachmentRowIds.entries()) {
          await tx.attachment.update({
            where: { id },
            data: { messageId: message.id, position },
          });
        }
        await input.withinSend?.(tx, {
          id: message.id,
          conversationId: channelId,
          workspaceId,
          body: stored.body,
          senderMemberId: member.id,
          threadRootId: root?.id ?? null,
        });
        created = true;
        createdState = {
          id: message.id,
          sequence: message.sequence,
          threadRootId: message.threadRootId,
          senderMemberId: member.id,
          body: message.body,
          createdAt: message.createdAt,
          attachments: attachmentRowIds.map((id) => availableById.get(id)!),
          mentionCount: stored.mentions.length,
          deliveryCount: recipients.length,
          recordedPendingActions,
        };
        return {
          ...message,
          target: `#${channel.channelName}${root ? `:${root.id}` : ""}`,
          attachments: [] as {
            id: string;
            fileName: string;
            contentType: string;
            sizeBytes: number;
          }[],
        };
      }),
  );
  const message = await loadSentChannelMessage(ctx.db, {
    channelId,
    senderMemberId: member.id,
    savedId: saved.id,
    createdState: created && !input.withinSend ? createdState : undefined,
    senderUser: member.user,
  });
  if (created) await ctx.notifications?.notifyMessage(message.id);
  const snapshot: AnnounceMessageSnapshot = {
    body: message.body,
    createdAt: message.createdAt,
    threadRootId: message.threadRootId,
    workspaceId,
    conversation: { channelName: channel.channelName, kind: null },
    sender: message.sender
      ? {
          userId: message.sender.user?.id ?? userId,
          agentId: message.sender.agentId,
          user: message.sender.user
            ? {
                displayName: message.sender.user.displayName,
                username: message.sender.user.username,
              }
            : null,
          agent: message.sender.agent
            ? {
                name: message.sender.agent.name,
                displayName: message.sender.agent.displayName,
              }
            : null,
        }
      : null,
    mentions: message.mentions,
    forwards: message.forwards,
    systemMessage: message.systemMessage,
    actionCard: null,
  };
  const announcement = announceMessageBestEffort(
    ctx.db,
    ctx.realtime,
    {
      conversationId: channelId,
      messageId: message.id,
      sequence: message.sequence,
      workspaceId,
      threadRootId: message.threadRootId ?? undefined,
      idempotencyKey,
      senderUserId: userId,
    },
    snapshot,
  );
  const publication = publishConcurrently(announcement, async () => {
    if (message.deliveries.length === 0) return;
    const publisher = ctx.publisher ?? createCentrifugoServerApi();
    const sender = agentMessageSender(message.sender);
    const taskViews = await taskReferenceViews(
      ctx.db,
      workspaceId,
      message.deliveries.map((delivery) => delivery.agentId),
      channelId,
      message.body,
    );
    const pushed = await new AgentDeliveryPublisher(
      publisher,
      new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(ctx.db)),
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
        forwarded: input.forwarded,
        target: `#${channel.channelName}${message.threadRootId ? `:${message.threadRootId}` : ""}`,
        latestSenderKind: sender.kind,
        latestSenderHandle: sender.handle,
        latestSenderDescription: sender.description,
        attachmentCount: new Set(attachmentIds ?? []).size,
        mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
        taskView: taskViews.get(delivery.agentId),
      })),
    );
    const failed = pushed.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  });
  const skipPendingActionsQuery = Boolean(
    createdState && createdState.recordedPendingActions === 0,
  );
  const postCommitReads = Promise.all([
    unresolvedMentionHandles(ctx.db, workspaceId, { userId }, message.body),
    skipPendingActionsQuery
      ? Promise.resolve([])
      : pendingMentionActionsForMessage(
          ctx.db,
          {
            id: message.id,
            workspaceId,
            conversationId: channelId,
            senderMemberId: member.id,
            body: message.body,
          },
          channel,
        ),
  ]);
  const [published, reads] = await Promise.allSettled([publication, postCommitReads]);
  if (published.status === "rejected") throw published.reason;
  if (reads.status === "rejected") throw reads.reason;
  const [unresolved, pendingMentionActions] = reads.value;
  return { ...message, unresolvedMentionHandles: unresolved, pendingMentionActions };
}

async function loadSentChannelMessage(
  db: PrismaClient,
  input: {
    channelId: string;
    senderMemberId: string;
    savedId: string;
    createdState?: CreatedChannelMessageState;
    senderUser?: {
      id: string;
      username: string;
      displayName: string | null;
      avatarObjectKey: string | null;
      description: string;
    } | null;
  },
) {
  if (input.createdState && input.senderUser) {
    const [mentions, deliveries] = await Promise.all([
      input.createdState.mentionCount > 0
        ? db.messageMention.findMany({
            where: { messageId: input.createdState.id },
            ...BROWSER_MESSAGE_MENTIONS_SELECT,
          })
        : Promise.resolve([]),
      input.createdState.deliveryCount > 0
        ? db.agentMessageDelivery.findMany({
            where: { messageId: input.createdState.id },
            select: { deliveryId: true, agentId: true, agent: { select: { computerId: true } } },
          })
        : Promise.resolve([]),
    ]);
    return {
      id: input.createdState.id,
      sequence: input.createdState.sequence,
      threadRootId: input.createdState.threadRootId,
      senderMemberId: input.createdState.senderMemberId,
      body: input.createdState.body,
      createdAt: input.createdState.createdAt,
      attachments: input.createdState.attachments,
      sender: {
        agentId: null,
        agent: null,
        user: input.senderUser,
      },
      mentions,
      reactionVersion: 0,
      reactions: [],
      forwards: [],
      systemMessage: null,
      deliveries,
    };
  }
  return db.message.findFirstOrThrow({
    where: {
      id: input.savedId,
      conversationId: input.channelId,
      senderMemberId: input.senderMemberId,
    },
    select: CHANNEL_SEND_RELOAD_SELECT,
  });
}
