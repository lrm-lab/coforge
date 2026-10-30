import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { ForwardedMessage, MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { recordThreadCreatedByReply } from "#src/server/app-notifications/channel-events.server";
import { userUploadedAttachmentWhere } from "#src/server/attachments/message-attachments.server";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import { memberChannel } from "./channel-access.server";
import { channelAgentRecipients } from "./channel-agent-recipients.server";
import { enrollThreadReplyFollowers } from "./channel-threads.server";
import { lockConversation } from "./conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { browserMessageFields } from "./conversation-history.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { MentionDeliveryIssuer } from "./mention-deliveries.server";
import { deliveryMentionsAgent } from "./mentions.server";
import { channelMentionTargets, storeMessageBody } from "./message-references.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { pendingMentionActionsForMessage } from "./pending-mention-views.server";
import {
  recordPendingMentionActions,
  unboundMentionTargets,
} from "./pending-mention-action-recording.server";
import { getMessageRequestIdempotency } from "./redis-message-request-idempotency.server";
import { agentMessageSender } from "./sender-display.server";
import type { SentMessageHook } from "./sent-message-hook.server";
import { unresolvedMentionHandles } from "./unresolved-mentions.server";

export type ChannelSendPorts = {
  db: PrismaClient;
  idempotency?: MessageRequestIdempotency;
  notifications?: MessageNotifier;
  realtime?: ConversationRealtime;
  publisher?: CentrifugoServerApi;
};
import { announceMessageBestEffort } from "./conversation-activity.server";

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
    /** Members the sender named by id (the composer's picks), beside the `@handle`s in `body`. */
    mentions?: readonly MentionSelectorInput[];
    /** Runs inside the send's transaction once the message and its uploads are written. */
    withinSend?: SentMessageHook;
    /** A forward's body is the forwarder's note and may be empty; no other send accepts that. */
    allowEmptyBody?: boolean;
    /** The forwarded original as an Agent that is delivered the message reads it. */
    forwarded?: ForwardedMessage;
  },
) {
  const { workspaceId, userId, channelId, idempotencyKey, attachmentIds, threadRootId } = input;
  // This key is also the daemon delivery's request_id. A missing one is omitted on the wire
  // and the daemon drops the frame, so the Agent never sees the message.
  if (!idempotencyKey?.trim()) throw new AppError("INVALID_INPUT");
  const channel = await memberChannel(ctx.db, workspaceId, userId, channelId);
  if (channel.archivedAt) throw new AppError("CONFLICT");
  const member = await ctx.db.conversationMember.findFirst({
    where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  const body = input.body.trim();
  // Postgres `message.body` is unbounded text. The browser composer stays at 8_000
  // (`sendConversationMessageInputSchema`); this path also accepts an eval prompt or an
  // Agent channel reply past that, which otherwise throws and kills the eval runner.
  if ((!body && !input.allowEmptyBody) || body.length > 64_000) throw new AppError("INVALID_INPUT");
  let created = false;
  const saved = await (ctx.idempotency ?? getMessageRequestIdempotency()).execute(
    { workspaceId, senderKind: "user", senderId: userId, idempotencyKey },
    () =>
      ctx.db.$transaction(async (tx) => {
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
        // A binding that stored no mention — its member left before the active-member read —
        // degrades the same.
        await recordPendingMentionActions(
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
  const message = await ctx.db.message.findFirstOrThrow({
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
  if (created) await ctx.notifications?.notifyMessage(message.id);
  await announceMessageBestEffort(ctx.db, ctx.realtime, {
    conversationId: channelId,
    messageId: message.id,
    sequence: message.sequence,
    workspaceId,
    threadRootId: message.threadRootId ?? undefined,
    idempotencyKey,
    // Only a person sends here; an Agent's channel message goes through `SendDirectMessage`.
    senderUserId: userId,
  });
  // Every Agent's push goes out at once; a failure still rejects the send. The encoder reads the
  // stored tokens back as text for the Agent.
  const publisher = ctx.publisher ?? createCentrifugoServerApi();
  // Routed through the shared projection rather than two non-null assertions on
  // `sender.user`, which broke for an Agent-authored channel delivery.
  const sender = agentMessageSender(message.sender);
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
      mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
    })),
  );
  const failed = pushed.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  // Read from the stored body, so an idempotent replay reads the same `@handle`s. These two
  // post-commit reads are independent, so they go together.
  const [unresolved, pendingMentionActions] = await Promise.all([
    unresolvedMentionHandles(ctx.db, workspaceId, { userId }, message.body),
    pendingMentionActionsForMessage(
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
  return { ...message, unresolvedMentionHandles: unresolved, pendingMentionActions };
}
