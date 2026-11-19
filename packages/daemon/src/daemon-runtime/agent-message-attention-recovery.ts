import {
  isValidMessageSender,
  type AgentRecoveryMessage,
  type AgentStartOpenTasks,
} from "@lrm/coforge-sdk/internal";
import { recoveryWakeupText } from "./agent-recovery-notice";
import type { AttentionDecisionOutcome } from "./agent-message-attention-decision-log";
import type { MessageAttention } from "./agent-message-attention-index";
import { foldMessageAttention, isDeliveryTarget } from "./message-attention-fields";

export type RecoveryPlan = Readonly<{
  byTarget: Map<string, MessageAttention>;
  recoveredMessages: readonly AgentRecoveryMessage[];
  announced: ReadonlySet<string>;
  notice: string;
}>;

export function planRecovery(input: {
  agentId: string;
  messages: readonly AgentRecoveryMessage[];
  unreadSummary: Readonly<Record<string, number>>;
  openTasks?: AgentStartOpenTasks;
  currentAttention: ReadonlyMap<string, MessageAttention>;
  seenDeliveryIds: ReadonlySet<string>;
  seenMessageIds: ReadonlySet<string>;
  alreadyRead(agentId: string, message: AgentRecoveryMessage): boolean;
  decide(message: AgentRecoveryMessage, outcome: AttentionDecisionOutcome): void;
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
    openTasks: input.openTasks,
  });
  return { byTarget, recoveredMessages, announced, notice };
}
