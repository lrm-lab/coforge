import {
  freshnessDecisionFactId,
  type FreshnessDecisionFactInput,
  isChannelMessageTarget,
  isChannelTarget,
  isValidReactionEmoji,
  type MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { AgentTargetFreshness } from "./agent-target-freshness.server";
import { planAgentSend } from "./agent-send-plan.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import type { PendingMentionActionView } from "#src/server/conversations/pending-mention-actions.server";
import {
  MessageRequestInProgressError,
  type MessageRequestRecords,
} from "#src/server/conversations/message-request-idempotency.server";

export type AgentMessageRepository = {
  /** One Agent-facing target resolved once, so a send's freshness reads and read-through advance
   * share that resolution instead of each resolving the target string again. */
  agentTargetFreshness?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<AgentTargetFreshness>;
  /** What a message this Agent already committed did not reach, read from the message by its id:
   * the report a replay of its send answers with, the same one the original send gave. */
  committedAgentMentionReport?(
    workspaceId: string,
    agentId: string,
    messageId: string,
  ): Promise<{
    pendingMentionActions: PendingMentionActionView[];
    unresolvedMentionHandles: string[];
  }>;
  setAgentChannelMuted(
    workspaceId: string,
    agentId: string,
    target: string,
    muted: boolean,
  ): Promise<unknown>;
  setAgentThreadFollowed(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
  ): Promise<unknown>;
  searchMessages?(
    workspaceId: string,
    agentId: string,
    options: Record<string, unknown>,
  ): Promise<{
    messages: readonly AgentMessageRecord[];
    hasMore: boolean;
    nextCursor?: string;
    incomplete: boolean;
    searchedMessages?: number;
    searchedThrough?: string;
  }>;
  readMessagesPage?(
    workspaceId: string,
    agentId: string,
    target: string,
    page: AgentMessagesPage,
  ): Promise<{
    messages: readonly AgentMessageRecord[];
    hasOlder: boolean;
    hasNewer: boolean;
    /** The `model_seen_up_to_seq`: see `agentHistoryModelSeenBoundary`. */
    modelSeenUpToSeq: number | null;
    consumptionScope?: AgentHistoryConsumptionScope;
    unreadCursorBefore?: number;
    readPositionAfter?: number;
    moreUnread?: boolean;
  }>;
  resolveAgentMessage?(
    workspaceId: string,
    agentId: string,
    messageId: string,
  ): Promise<AgentMessageRecord>;
  setAgentMessageReaction?(
    workspaceId: string,
    agentId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ): Promise<{ messageId: string }>;
  drainAgentEvents?(
    workspaceId: string,
    agentId: string,
    limit?: number,
    target?: string,
  ): Promise<{ messages: readonly AgentMessageRecord[]; hasMore: boolean }>;
};

export type AgentMessagesPage = {
  unread?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  fromSequence?: number;
  throughSequence?: number;
};

export type AgentMentionSelector = { type: "user" | "agent"; id: string; name: string };

export type AgentSendMessageInput = {
  idempotencyKey: string;
  workspaceId: string;
  agentId: string;
  target: string;
  content: string;
  continueAnyway?: boolean;
  /** How many times this draft has already been held (the local draft's `reholdCount`). */
  draftReholdCount?: number;
  /** A normal send that replaced a draft the Agent had already been held on. */
  draftReplacedExisting?: boolean;
  seenUpToSeq?: number;
  /** `seenExactSeqs`: messages above `seenUpToSeq` the Agent was shown one by one. */
  seenExactSeqs?: readonly number[];
  freshnessContextMode?: "inline" | "withheld";
  attachmentIds?: string[];
  mentions?: AgentMentionSelector[];
};

export type AgentSendMessageResult = {
  state: "sent" | "held";
  /** The side-effect decision: `forward`/`bypass` sent the message, `local_hold`/`syncing_hold`
   * held it as a draft. There is deliberately no "denied" outcome. */
  decision: "forward" | "bypass" | "local_hold" | "syncing_hold";
  reason?: string;
  messageId?: string;
  producerFactId?: string;
  /** The `available_actions` on a held send. */
  availableActions?: readonly string[];
  /** `continueAnywaySuggested`: an already-re-held draft may be forced with `--anyway`. */
  continueAnywaySuggested?: boolean;
  heldMessages?: readonly AgentMessageRecord[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  /** Held: the boundary the Agent should treat as reviewed after this hold. Sent: the boundary this
   * send advanced over messages the Agent had already seen (the consume effect), if any. */
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Only when a sent message bypassed a hold and `freshnessContextMode !== "withheld"`. */
  recentUnread?: readonly AgentMessageRecord[];
  /** Sent only: mentions of people outside the channel that notified no one, for the Agent to
   * act on (`coforge mention`). */
  pendingMentionActions?: readonly PendingMentionActionView[];
  /** Sent only: `@handle`s that name nobody the Agent can see. */
  unresolvedMentionHandles?: readonly string[];
  /** Sent only: the channel this send joined on the way, as `#name`. */
  joinedChannel?: string;
};

/** Normalizing a held freshness and building the decision's producer fact id now live in the SDK
 * (`@lrm/coforge-sdk/internal`), because a daemon that decides a hold locally never reaches the
 * server's code path and still has to produce the same `freshness_decision_fact:` id. */

async function executeAgentSendMessage(
  sender: {
    executeFromAgent(input: {
      idempotencyKey: string;
      workspaceId: string;
      agentId: string;
      target: string;
      body: string;
      attachmentIds?: string[];
      mentions?: AgentMentionSelector[];
    }): Promise<{
      id: string;
      /** Present when this send joined the channel it posted to, as `#name`. */
      joinedChannel?: string;
      pendingMentionActions?: readonly PendingMentionActionView[];
      unresolvedMentionHandles?: readonly string[];
    }>;
  },
  input: AgentSendMessageInput,
): Promise<{
  messageId: string;
  joinedChannel?: string;
  pendingMentionActions: readonly PendingMentionActionView[];
  unresolvedMentionHandles: readonly string[];
}> {
  const message = await sender.executeFromAgent({
    idempotencyKey: input.idempotencyKey,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    target: input.target,
    body: input.content,
    attachmentIds: input.attachmentIds,
    mentions: input.mentions,
  });
  return {
    messageId: message.id,
    joinedChannel: message.joinedChannel,
    pendingMentionActions: message.pendingMentionActions ?? [],
    unresolvedMentionHandles: message.unresolvedMentionHandles ?? [],
  };
}

/** The answer to an Agent's `reconcileOnly` send. */
export type AgentSendReconciliation =
  | { state: "committed"; messageId: string }
  | { state: "not_found" };

/**
 * Whether an Agent's send under this idempotency key already committed, answered from the same
 * request record `executeFromAgent` writes — without the freshness check, a hold, or a send. A key
 * still being processed is the in-flight duplicate `MessageRequestInProgressError` reports:
 * the `reconcileOnly` contract has no state for it, and the daemon treats it as "cannot confirm".
 */
export async function reconcileAgentSendMessage(
  records: MessageRequestRecords,
  input: { idempotencyKey: string; workspaceId: string; agentId: string },
): Promise<AgentSendReconciliation> {
  const record = await records.find({
    workspaceId: input.workspaceId,
    senderKind: "agent",
    senderId: input.agentId,
    idempotencyKey: input.idempotencyKey,
  });
  if (!record) return { state: "not_found" };
  if (record.state === "processing") throw new MessageRequestInProgressError();
  return { state: "committed", messageId: record.message.id };
}

/**
 * The plan for a send's effect on the Agent's inbox, and for a first touch's recent context,
 * decided on the server, where the target's pending and recent context live. A message counts as
 * seen when the Agent sent it, when it is at or below the boundary the Agent reported, or when the
 * Agent reports it among `seenExactSeqs`, whatever the freshness mode. The consume effects are the
 * read-through advance here and the `seenUpToSeq` a sent result carries back to the daemon.
 */
export async function executeAgentSendMessageWithPolicy(
  dependencies: {
    repository: Pick<
      AgentMessageRepository,
      "agentTargetFreshness" | "committedAgentMentionReport"
    >;
    sender: Parameters<typeof executeAgentSendMessage>[0];
    /** The send's request records: a key that already committed is answered from its record. */
    requestRecords?: MessageRequestRecords;
  },
  input: AgentSendMessageInput,
): Promise<AgentSendMessageResult> {
  // A replay of a key that already committed is answered from its record before the target is
  // resolved or its freshness read: whatever changed since (the person left, newer messages
  // arrived) must not report a committed send as refused or held. Like a `reconcileOnly`
  // `committed`, it publishes nothing again; what the message did not reach is read from the
  // message, so the replay reports what the original did. A key still being processed is the
  // in-flight duplicate.
  if (dependencies.requestRecords) {
    const reconciliation = await reconcileAgentSendMessage(dependencies.requestRecords, input);
    if (reconciliation.state === "committed") {
      const report = await dependencies.repository.committedAgentMentionReport?.(
        input.workspaceId,
        input.agentId,
        reconciliation.messageId,
      );
      return {
        state: "sent",
        decision: "forward",
        reason: "already_committed",
        messageId: reconciliation.messageId,
        pendingMentionActions: report?.pendingMentionActions ?? [],
        unresolvedMentionHandles: report?.unresolvedMentionHandles ?? [],
      };
    }
  }
  const mode = input.freshnessContextMode ?? "inline";
  const freshness = await dependencies.repository.agentTargetFreshness?.(
    input.workspaceId,
    input.agentId,
    input.target,
  );
  const factId = (fact: Omit<FreshnessDecisionFactInput, "agentId" | "target">) =>
    freshnessDecisionFactId({
      agentId: input.agentId,
      target: input.target,
      freshnessContextMode: mode,
      ...fact,
    });
  const plan = await planAgentSend(freshness, input, factId);
  if ("state" in plan) return plan;
  const advanced =
    plan.advanceTo !== undefined ? await advance(freshness, plan.advanceTo) : undefined;
  const sent = await executeAgentSendMessage(dependencies.sender, input);
  return {
    state: "sent",
    decision: plan.decision,
    reason: plan.reason,
    messageId: sent.messageId,
    joinedChannel: sent.joinedChannel,
    pendingMentionActions: sent.pendingMentionActions,
    unresolvedMentionHandles: sent.unresolvedMentionHandles,
    producerFactId: await factId({ decision: plan.decision, reason: plan.reason, ...plan.fact }),
    ...(advanced !== undefined ? { seenUpToSeq: advanced } : {}),
    ...(plan.recentUnread ? { recentUnread: plan.recentUnread } : {}),
  };
}

/** The consume effect on the server: the read-through advances over messages the Agent has
 * seen, and the result tells the daemon the boundary it reached. */
async function advance(
  freshness: AgentTargetFreshness | undefined,
  sequence: number,
): Promise<number | undefined> {
  if (!freshness?.advanceReadThrough) return undefined;
  const reached = await freshness.advanceReadThrough(sequence);
  return reached > 0 ? reached : undefined;
}

export async function readAgentMessages(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  target: string,
  page: AgentMessagesPage,
) {
  if (!repository.readMessagesPage) throw new Error("Agent message read is unavailable");
  const result = await repository.readMessagesPage(scope.workspaceId, scope.agentId, target, page);
  return {
    ...result,
    messages: result.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export type AgentMessageRecord = {
  id: string;
  sequence: number;
  senderKind: MessageSenderKind;
  /** Public handle without a leading "@"; required for "human"/"agent", empty for "system". */
  senderHandle: string;
  /** The sender's role text; empty when there is none. */
  senderDescription: string;
  target: string;
  body: string;
  channelCoordination?: string;
  createdAt: Date;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
  mentionsAgent?: boolean;
};

export async function drainAgentEvents(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  limit?: number,
  target?: string,
) {
  if (!repository.drainAgentEvents) throw new Error("Agent event drain is unavailable");
  const result = await repository.drainAgentEvents(scope.workspaceId, scope.agentId, limit, target);
  return {
    ...result,
    messages: result.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export async function muteAgentChannel(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  target: string,
  muted: boolean,
) {
  if (!isChannelTarget(target)) throw new Error("mute requires a channel target");
  await repository.setAgentChannelMuted(scope.workspaceId, scope.agentId, target, muted);
}

export async function unfollowAgentThread(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  target: string,
) {
  if (!isChannelMessageTarget(target) || isChannelTarget(target))
    throw new Error("unfollow requires a channel thread target");
  await repository.setAgentThreadFollowed(scope.workspaceId, scope.agentId, target, false);
}

export async function resolveAgentMessage(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  messageId: string,
) {
  if (!repository.resolveAgentMessage) throw new Error("Agent message resolve is unavailable");
  const message = await repository.resolveAgentMessage(scope.workspaceId, scope.agentId, messageId);
  return { ...message, createdAt: message.createdAt.toISOString() };
}

export async function reactToAgentMessage(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  messageId: string,
  emoji: string,
  active: boolean,
) {
  if (!repository.setAgentMessageReaction) throw new Error("Agent message reaction is unavailable");
  if (!isValidReactionEmoji(emoji))
    throw new AgentMessageValidationError(
      "reaction emoji must be one to sixteen characters without whitespace",
    );
  return repository.setAgentMessageReaction(
    scope.workspaceId,
    scope.agentId,
    messageId,
    emoji,
    active,
  );
}
