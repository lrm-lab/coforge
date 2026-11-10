import { isValidMessageSender, type AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";
import { recoveryWakeupText } from "./agent-recovery-notice";
import type { AttentionDecisionOutcome } from "./agent-message-attention-decision-log";
import type { MessageAttention } from "./agent-message-attention-index";
import { foldMessageAttention, isDeliveryTarget } from "./message-attention-fields";

/** What the recovery notice announces, decided before the notice is written. */
export type RecoveryPlan = Readonly<{
  /** The attention the Agent holds once the notice is accepted. */
  byTarget: Map<string, MessageAttention>;
  /** The supplied messages the notice announces: not already read, not already notified. */
  recoveredMessages: readonly AgentRecoveryMessage[];
  /** Every target the notice announces, supplied or summary-only. */
  announced: ReadonlySet<string>;
  notice: string;
}>;

/**
 * Validates a recovery's messages and decides what its notice announces. Undefined when everything
 * named was already read or notified and no summary-only target remains.
 */
export function planRecovery(input: {
  agentId: string;
  messages: readonly AgentRecoveryMessage[];
  unreadSummary: Readonly<Record<string, number>>;
  currentAttention: ReadonlyMap<string, MessageAttention>;
  seenDeliveryIds: ReadonlySet<string>;
  seenMessageIds: ReadonlySet<string>;
  alreadyRead(agentId: string, message: AgentRecoveryMessage): boolean;
  decide(message: AgentRecoveryMessage, outcome: AttentionDecisionOutcome): void;
  hasToolProfile: boolean;
}): RecoveryPlan | undefined {
  const { agentId, messages, unreadSummary, decide } = input;
  const byTarget = new Map(input.currentAttention);
  const recoveredTargets = new Set<string>();
  const suppliedTargets = new Set<string>();
  const recoveredMessages: AgentRecoveryMessage[] = [];
  for (const message of [...messages].sort(
    (left, right) =>
      left.conversationId.localeCompare(right.conversationId) || left.sequence - right.sequence,
  )) {
    if (
      !message.messageId ||
      !message.deliveryId ||
      !message.conversationId ||
      !message.body ||
      !isDeliveryTarget(message.target) ||
      message.sequence < 1 ||
      !isValidMessageSender(message.latestSenderKind, message.latestSenderHandle)
    )
      throw new Error("invalid Agent recovery message");
    suppliedTargets.add(message.target);
    if (input.alreadyRead(agentId, message)) {
      decide(message, "consumed");
      continue;
    }
    if (
      input.seenDeliveryIds.has(message.deliveryId) ||
      input.seenMessageIds.has(message.messageId)
    ) {
      decide(message, "already_notified");
      continue;
    }
    recoveredMessages.push(message);
    recoveredTargets.add(message.target);
    decide(message, "notified");
    foldMessageAttention(byTarget, message);
  }
  const summaryOnly = Object.entries(unreadSummary).filter(
    ([target, count]) => !suppliedTargets.has(target) && isDeliveryTarget(target) && count > 0,
  );
  if (!recoveredTargets.size && !summaryOnly.length) return undefined;
  const announced = new Set([...recoveredTargets, ...summaryOnly.map(([target]) => target)]);
  const notice = recoveryWakeupText({
    agentId,
    announced: recoveredMessages,
    summaryOnly,
    hasToolProfile: input.hasToolProfile,
  });
  return { byTarget, recoveredMessages, announced, notice };
}
