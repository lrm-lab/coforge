import type { SentMessageHook } from "./sent-message-hook.server";
import {
  isChannelMessageTarget,
  isPrintableSenderHandle,
  type ForwardedMessage,
} from "@lrm/coforge-sdk/internal";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type {
  DirectConversationRepository,
  LatestSenderFields,
} from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { announceMemberChanged, type ConversationRealtime } from "./conversation-realtime.server";
import { AppError, isAppErrorCode } from "#src/lib/app-error";
import { deliveryMentionsAgent } from "./mentions.server";
import { dmParentTarget } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import type { MentionDeliveryIssuer } from "./mention-deliveries.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import {
  announceMessageBestEffort,
  type AnnounceMessageSnapshot,
} from "./conversation-activity.server";
import { publishConcurrently } from "./concurrent-publication.server";

export class ReadDirectMessages {
  constructor(private readonly conversations: DirectConversationRepository) {}

  async execute(input: { workspaceId: string; agentId: string; target: string }) {
    const userId = await this.conversations.userIdForUsername?.(input.target);
    if (!userId) throw new AppError("TARGET_NOT_ACCESSIBLE");
    await this.conversations.getOrCreateUserAgent(input.workspaceId, userId, input.agentId);
    const messages = await this.conversations.readMessages?.(
      input.workspaceId,
      input.agentId,
      input.target,
    );
    if (!messages) throw new Error("message reading is unavailable");
    return messages;
  }
}

export class SendDirectMessage {
  constructor(
    private readonly conversations: DirectConversationRepository,
    private readonly idempotency: MessageRequestIdempotency,
    private readonly centrifugo: Pick<CentrifugoServerApi, "publishBatch">,
    private readonly realtime?: ConversationRealtime,
    private readonly notifications?: MessageNotifier,
    private readonly mentionIssuer?: Pick<MentionDeliveryIssuer, "issue">,
  ) {}

  async execute(input: {
    idempotencyKey: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    senderUserId: string;
    body: string;
    attachmentIds?: string[];
    threadRootId?: string;
    withinSend?: SentMessageHook;
    allowEmptyBody?: boolean;
    forwarded?: readonly ForwardedMessage[];
  }) {
    if (!input.idempotencyKey || (!input.body && !input.allowEmptyBody))
      throw new Error("invalid direct message");
    let userSenderDisplayName: string | null | undefined;
    const message = await this.idempotency.execute(
      {
        workspaceId: input.workspaceId,
        senderKind: "user",
        senderId: input.senderUserId,
        idempotencyKey: input.idempotencyKey,
      },
      async () => {
        const persisted = await this.conversations.sendMessage(
          input.conversationId,
          input.senderMemberId,
          input.senderUserId,
          input.body,
          input.attachmentIds,
          input.threadRootId,
          input.withinSend,
        );
        userSenderDisplayName = persisted.senderDisplayName;
        return persisted;
      },
    );
    const { agentId } = message;
    if (!agentId) throw new Error("message is not an Agent direct message");
    const userSnapshot: AnnounceMessageSnapshot | undefined =
      !input.withinSend &&
      userSenderDisplayName !== undefined &&
      message.latestSenderHandle &&
      typeof message.body === "string" &&
      message.createdAt instanceof Date
        ? {
            body: message.body,
            createdAt: message.createdAt,
            threadRootId: message.threadRootId ?? null,
            workspaceId: message.workspaceId,
            conversation: { channelName: null, kind: null },
            sender: {
              userId: input.senderUserId,
              agentId: null,
              user: {
                displayName: userSenderDisplayName,
                username: message.latestSenderHandle,
              },
              agent: null,
            },
            mentions: [],
            forwards: [],
            systemMessage: null,
            actionCard: null,
          }
        : undefined;
    await publishConcurrently(
      this.publishBrowserEvent(
        message,
        input.conversationId,
        { userId: input.senderUserId, agentId, senderUserId: input.senderUserId },
        input.idempotencyKey,
        userSnapshot,
      ),
      () =>
        this.publishUserMessageToAgent(
          input.idempotencyKey,
          input.conversationId,
          { ...message, agentId },
          input.attachmentIds?.length ?? 0,
          input.forwarded,
        ),
    );
    return message;
  }

  async executeFromAgent(input: {
    idempotencyKey: string;
    workspaceId: string;
    agentId: string;
    target: string;
    body: string;
    attachmentIds?: string[];
    mentions?: readonly { type: "user" | "agent"; id: string; name: string }[];
  }) {
    if (
      !input.idempotencyKey ||
      !input.body ||
      (!input.target.startsWith("@") && !isChannelMessageTarget(input.target))
    )
      throw new Error("invalid agent direct message");
    const isChannel = isChannelMessageTarget(input.target);
    const direct = isChannel
      ? undefined
      : await this.conversations.openAgentDirect?.(
          input.workspaceId,
          input.agentId,
          dmParentTarget(input.target),
        );
    if (!isChannel && !direct) throw new AppError("TARGET_NOT_ACCESSIBLE");
    const dmUserId = direct?.peer.kind === "user" ? direct.peer.userId : undefined;
    const sendChannel = isChannel
      ? await (this.conversations.getAgentSendChannel ?? this.conversations.getAgentChannel)?.call(
          this.conversations,
          input.workspaceId,
          input.agentId,
          input.target.split(":")[0]!,
        )
      : undefined;
    const conversation = isChannel ? sendChannel : direct?.conversation;
    if (!conversation) throw new Error("channel access is unavailable");
    let persistedAgentMeta:
      | {
          mentionCount: number;
          senderDisplayName: string | null | undefined;
          channelName: string | null | undefined;
        }
      | undefined;
    const message = await this.idempotency.execute(
      {
        workspaceId: input.workspaceId,
        senderKind: "agent",
        senderId: input.agentId,
        idempotencyKey: input.idempotencyKey,
      },
      async () => {
        const persisted = await this.conversations
          .sendAgentMessage?.(
            conversation.id,
            input.agentId,
            input.body,
            input.attachmentIds,
            input.target.split(":")[1],
            input.mentions,
            isChannel && (sendChannel as { needsJoin?: boolean } | undefined)?.needsJoin === true,
          )
          .catch(async (error: unknown) => {
            if (isAppErrorCode(error, "AGENT_DM_CHAIN_LIMIT", "AGENT_DM_RATE_LIMIT"))
              await this.conversations
                .noteAgentDmLimit?.({
                  conversationId: conversation.id,
                  workspaceId: input.workspaceId,
                  code: error.code,
                })
                .catch(() => {});
            throw error;
          });
        if (!persisted) throw new Error("agent message persistence is unavailable");
        persistedAgentMeta = {
          mentionCount: persisted.mentions?.length ?? 0,
          senderDisplayName: persisted.senderDisplayName,
          channelName: persisted.channelName,
        };
        return persisted;
      },
    );
    if (message.joinedChannel)
      await announceMemberChanged(this.realtime, {
        workspaceId: input.workspaceId,
        conversationIds: [conversation.id],
      });
    const agentSnapshot: AnnounceMessageSnapshot | undefined =
      persistedAgentMeta &&
      persistedAgentMeta.mentionCount === 0 &&
      persistedAgentMeta.senderDisplayName !== undefined &&
      persistedAgentMeta.channelName !== undefined &&
      message.latestSenderHandle &&
      typeof message.body === "string" &&
      message.createdAt instanceof Date
        ? {
            body: message.body,
            createdAt: message.createdAt,
            threadRootId: message.threadRootId ?? null,
            workspaceId: message.workspaceId,
            conversation: { channelName: persistedAgentMeta.channelName, kind: null },
            sender: {
              userId: null,
              agentId: input.agentId,
              user: null,
              agent: {
                name: message.latestSenderHandle,
                displayName: persistedAgentMeta.senderDisplayName,
              },
            },
            mentions: [],
            forwards: [],
            systemMessage: null,
            actionCard: null,
          }
        : undefined;
    const browser = (async () => {
      if (!isChannel && !dmUserId) return;
      await this.publishBrowserEvent(
        message,
        conversation.id,
        isChannel
          ? { workspaceId: input.workspaceId }
          : { userId: dmUserId!, agentId: input.agentId },
        undefined,
        agentSnapshot,
      );
      await this.notifications?.notifyMessage(message.id);
    })();
    const publications = publishConcurrently(browser, () =>
      this.publishAgentMentionDeliveries(input.idempotencyKey, conversation.id, message),
    );
    const reading = (async () =>
      (await this.conversations.agentMentionReport?.(input.workspaceId, input.agentId, {
        id: message.id,
        conversationId: conversation.id,
        body: message.body,
      })) ?? { pendingMentionActions: [], unresolvedMentionHandles: [] })();
    const [published, report] = await Promise.allSettled([publications, reading]);
    if (published.status === "rejected") throw published.reason;
    if (report.status === "rejected") throw report.reason;
    return { ...message, ...report.value };
  }

  private async publishAgentMentionDeliveries(
    idempotencyKey: string,
    conversationId: string,
    message: {
      id: string;
      sequence: number;
      createdAt: Date;
      body: string;
      workspaceId: string;
      target?: string;
      mentions?: { kind: string; actorId: string; handle: string }[];
      deliveries?: { deliveryId: string; agentId: string; computerId: string | null }[];
    } & Partial<LatestSenderFields>,
  ) {
    if (!message.deliveries?.length) return;
    await new AgentDeliveryPublisher(this.centrifugo, this.mentionIssuer).publish(
      message.workspaceId,
      message.deliveries.map((delivery) => ({
        computerId: delivery.computerId,
        requestId: idempotencyKey,
        conversationId,
        agentId: delivery.agentId,
        messageId: message.id,
        deliveryId: delivery.deliveryId,
        sequence: message.sequence,
        createdAtMs: message.createdAt.getTime(),
        body: message.body,
        mentions: message.mentions ?? [],
        target: message.target ?? "",
        latestSenderKind: message.latestSenderKind,
        latestSenderHandle: message.latestSenderHandle,
        latestSenderDescription: message.latestSenderDescription,
        mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
      })),
    );
  }

  private async publishBrowserEvent(
    message: { id: string; sequence: number; threadRootId?: string | null },
    conversationId: string,
    scope: { workspaceId?: string; userId?: string; agentId?: string; senderUserId?: string },
    idempotencyKey?: string,
    snapshot?: AnnounceMessageSnapshot,
  ) {
    await announceMessageBestEffort(
      this.conversations.database,
      this.realtime,
      {
        conversationId,
        messageId: message.id,
        sequence: message.sequence,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId ? { userId: scope.userId } : {}),
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(scope.senderUserId ? { senderUserId: scope.senderUserId } : {}),
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      snapshot,
    );
  }

  private async publishUserMessageToAgent(
    idempotencyKey: string,
    conversationId: string,
    message: Awaited<ReturnType<DirectConversationRepository["sendMessage"]>>,
    attachmentCount: number,
    forwarded?: readonly ForwardedMessage[],
  ) {
    if (!message) throw new Error("message publication is unavailable");
    if (!message.deliveryId) throw new Error("message delivery is unavailable");
    if (
      message.latestSenderKind !== "human" ||
      !message.latestSenderHandle ||
      !isPrintableSenderHandle(message.latestSenderHandle)
    )
      throw new Error("message sender must be a public @username");
    if (message.inboxPolled) return;
    if (!message.computerId) {
      console.error("Agent delivery deferred: Agent has no assigned Computer", {
        conversationId,
        agentId: message.agentId,
      });
      return;
    }
    const [pushed] = await new AgentDeliveryPublisher(this.centrifugo, this.mentionIssuer).publish(
      message.workspaceId,
      [
        {
          computerId: message.computerId,
          requestId: idempotencyKey,
          messageId: message.id,
          deliveryId: message.deliveryId,
          sequence: message.sequence,
          createdAtMs: message.createdAt.getTime(),
          conversationId,
          agentId: message.agentId,
          body: message.body,
          mentions: [],
          forwarded,
          target: message.deliveryTarget ?? `@${message.latestSenderHandle}`,
          latestSenderKind: message.latestSenderKind,
          latestSenderHandle: message.latestSenderHandle,
          latestSenderDescription: message.latestSenderDescription,
          attachmentCount,
        },
      ],
    );
    if (pushed?.status === "rejected")
      console.error("Agent delivery failed after retries", {
        conversationId,
        agentId: message.agentId,
        error: pushed.reason,
      });
  }
}
