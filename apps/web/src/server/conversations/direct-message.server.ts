import type { SentMessageHook } from "./sent-message-hook.server";
import { isChannelMessageTarget, isPrintableSenderHandle } from "@lrm/coforge-sdk/internal";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type {
  DirectConversationRepository,
  LatestSenderFields,
} from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { announceMemberChanged, type ConversationRealtime } from "./conversation-realtime.server";
import { isAppErrorCode } from "#src/lib/app-error";
import { deliveryMentionsAgent } from "./mentions.server";
import { dmParentTarget } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import type { MentionDeliveryIssuer } from "./mention-deliveries.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";

export class ReadDirectMessages {
  constructor(private readonly conversations: DirectConversationRepository) {}

  async execute(input: { workspaceId: string; agentId: string; target: string }) {
    const userId = await this.conversations.userIdForUsername?.(input.target);
    if (!userId) throw new Error("target user not found");
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

/** Persists a canonical User-Agent direct message before attempting transport publication. */
export class SendDirectMessage {
  constructor(
    private readonly conversations: DirectConversationRepository,
    private readonly idempotency: MessageRequestIdempotency,
    private readonly centrifugo: Pick<CentrifugoServerApi, "publish">,
    private readonly realtime?: ConversationRealtime,
    private readonly notifications?: MessageNotifier,
    /** Tracks the @mentions an Agent's message delivers; untracked without it. */
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
    /** Runs inside the send's transaction once the message and its uploads are written. */
    withinSend?: SentMessageHook;
  }) {
    if (!input.idempotencyKey || !input.body) throw new Error("invalid direct message");
    const message = await this.idempotency.execute(
      {
        workspaceId: input.workspaceId,
        senderKind: "user",
        senderId: input.senderUserId,
        idempotencyKey: input.idempotencyKey,
      },
      () =>
        this.conversations.sendMessage(
          input.conversationId,
          input.senderMemberId,
          input.senderUserId,
          input.body,
          input.attachmentIds,
          input.threadRootId,
          input.withinSend,
        ),
    );
    if (!message.agentId) throw new Error("message is not an Agent direct message");
    // The sender is the only human in a DM with an Agent: their own channel carries the signal so
    // their other tabs and devices refresh the DM row. The message names the sender, so it never
    // bumps their own badge.
    await this.publishBrowserEvent(
      message,
      input.conversationId,
      { userId: input.senderUserId, agentId: message.agentId, senderUserId: input.senderUserId },
      input.idempotencyKey,
    );
    await this.publishUserMessageToAgent(input.idempotencyKey, input.conversationId, {
      ...message,
      agentId: message.agentId,
    });
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
    // A direct target names a person (their DM with this Agent) or another Agent (their shared DM).
    const direct = isChannel
      ? undefined
      : await this.conversations.openAgentDirect?.(
          input.workspaceId,
          input.agentId,
          dmParentTarget(input.target),
        );
    if (!isChannel && !direct) throw new Error("target user not found");
    const dmUserId = direct?.peer.kind === "user" ? direct.peer.userId : undefined;
    // The send path's channel: the Agent's own, or one it can still join on the way to posting —
    // the send's transaction writes that membership with the message.
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
            undefined,
            isChannel && (sendChannel as { needsJoin?: boolean } | undefined)?.needsJoin === true,
          )
          .catch(async (error: unknown) => {
            // A limit between two Agents is told to whoever reads their conversation, once.
            if (isAppErrorCode(error, "AGENT_DM_CHAIN_LIMIT", "AGENT_DM_RATE_LIMIT"))
              // Best effort: a failed notice must not hide the refusal from the Agent.
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
        return persisted;
      },
    );
    // A send that joined the channel on the way announces the roster change like `channel join`.
    if (message.joinedChannel)
      await announceMemberChanged(this.realtime, {
        workspaceId: input.workspaceId,
        conversationIds: [conversation.id],
      });
    const publications = (async () => {
      // A channel message fans out to the Workspace; a DM goes only to its human viewer, naming
      // the sending Agent's badge so the browser needs no conversation alias. A DM between two
      // Agents has no viewer and nobody to notify: only the delivery below.
      if (isChannel || dmUserId) {
        await this.publishBrowserEvent(
          message,
          conversation.id,
          isChannel
            ? { workspaceId: input.workspaceId }
            : { userId: dmUserId!, agentId: input.agentId },
        );
        await this.notifications?.notifyMessage(message.id);
      }
      await this.publishAgentMentionDeliveries(input.idempotencyKey, conversation.id, message);
    })();
    // What the message did not reach, read from the stored message so a replay reports the same.
    // It reads only what the send committed, so it runs alongside the publications; both settle
    // before the send answers, as when they ran one after the other.
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

  /**
   * Push a committed channel Message to every Agent it was delivered to. Best effort: attention
   * is volatile, the canonical Message/read boundary recovers a missed publication, and a
   * publish failure must not reject a send the database already accepted.
   */
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
    /** A person's send only: lets the sender's page match its pending copy. */
    idempotencyKey?: string,
  ) {
    if (!this.realtime) return;
    try {
      await this.realtime.messageAvailable({
        conversationId,
        messageId: message.id,
        sequence: message.sequence,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId ? { userId: scope.userId } : {}),
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(scope.senderUserId ? { senderUserId: scope.senderUserId } : {}),
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    } catch {
      // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
    }
  }

  private async publishUserMessageToAgent(
    idempotencyKey: string,
    conversationId: string,
    message: Awaited<ReturnType<DirectConversationRepository["sendMessage"]>>,
  ) {
    if (!message) throw new Error("message publication is unavailable");
    if (!message.deliveryId) throw new Error("message delivery is unavailable");
    // This path only ever carries a human sender (a browser-authored direct message). The shared
    // `agentMessageSender` projection already failed loudly upstream if the handle could not be
    // resolved, but this guard checks something that projection cannot: that the resolved sender
    // is specifically `human` on this human-only send path (never `agent`, never absent), and
    // that the handle is well-formed. `encodeAgentMessageDelivery`'s own boundary check does not
    // cover an entirely absent `latestSenderKind`, so this stays the one place that does.
    if (
      message.latestSenderKind !== "human" ||
      !message.latestSenderHandle ||
      !isPrintableSenderHandle(message.latestSenderHandle)
    )
      throw new Error("message sender must be a public @username");
    // An app's bot has no Computer and no daemon: the message waits for its app's inbox poll.
    if (message.appBot) return;
    if (!message.computerId) throw new Error("Agent is not assigned to a Computer");
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
          // A DM has no mention rows; its task and channel tokens still read back as text. It
          // carries no `mentionsAgent`, so the issuer tracks it only once a DM can mention.
          body: message.body,
          mentions: [],
          target: message.deliveryTarget ?? `@${message.latestSenderHandle}`,
          latestSenderKind: message.latestSenderKind,
          latestSenderHandle: message.latestSenderHandle,
          latestSenderDescription: message.latestSenderDescription,
        },
      ],
    );
    if (pushed?.status === "rejected") throw pushed.reason;
  }
}
