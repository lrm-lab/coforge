import {
  isValidMessageSender,
  type AgentRecoveryMessage,
  type AgentStartOpenTasks,
} from "@lrm/coforge-sdk/internal";
import { composeRecoveryNotice } from "./agent-recovery-notice";
import type {
  AttentionDecisionOutcome,
  AttentionDecisionBasis,
  AttentionReadBasis,
} from "./agent-message-attention-decision-log";
import type { MessageAttention } from "./agent-message-attention-index";
import { foldMessageAttention, isDeliveryTarget } from "./message-attention-fields";
import { isOrdinaryNotice, noticeMessageKey, type NoticeMessage } from "./accepted-message-notices";

export type RecoveryPlan = Readonly<{
  byTarget: Map<string, MessageAttention>;
  recoveredMessages: readonly AgentRecoveryMessage[];
  acceptedMessages: readonly NoticeMessage[];
  announced: ReadonlySet<string>;
  notice: string;
  recoveredMessageCount: number;
  summaryUnreadCount: number;
}>;

export type RecoveryNoticeOptions = {
  snapshotMessages: readonly AgentRecoveryMessage[];
  countedDeliveries?: readonly NoticeMessage[];
  accepted(messages: readonly NoticeMessage[]): void;
};

export function planRecovery(input: {
  agentId: string;
  messages: readonly AgentRecoveryMessage[];
  unreadSummary: Readonly<Record<string, number>>;
  unreadConversationIds: Readonly<Record<string, string>>;
  snapshotMessages: readonly AgentRecoveryMessage[];
  countedDeliveries?: readonly NoticeMessage[];
  openTasks?: AgentStartOpenTasks;
  currentAttention: ReadonlyMap<string, MessageAttention>;
  seenDeliveryIds: ReadonlySet<string>;
  seenMessageIds: ReadonlySet<string>;
  readBasis(agentId: string, message: AgentRecoveryMessage): AttentionReadBasis | undefined;
  notificationInFlight(message: AgentRecoveryMessage): boolean;
  alreadyNotified(message: AgentRecoveryMessage): boolean;
  decide(
    message: AgentRecoveryMessage,
    outcome: AttentionDecisionOutcome,
    basis?: AttentionDecisionBasis,
  ): void;
}): RecoveryPlan | undefined {
  const { agentId, messages, unreadSummary, decide } = input;
  const byTarget = new Map(input.currentAttention);
  const recoveredTargets = new Set<string>();
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
    const readBasis = input.readBasis(agentId, message);
    if (readBasis) {
      decide(message, "consumed", readBasis);
      continue;
    }
    if (
      input.seenDeliveryIds.has(message.deliveryId) ||
      input.seenMessageIds.has(message.messageId)
    ) {
      decide(
        message,
        input.notificationInFlight(message) ? "notification_in_flight" : "already_notified",
      );
      continue;
    }
    if (input.alreadyNotified(message)) {
      decide(message, "already_notified", "accepted_message");
      continue;
    }
    recoveredMessages.push(message);
    recoveredTargets.add(message.target);
    decide(message, "notified");
    foldMessageAttention(byTarget, message);
  }
  const enumerated = new Map<string, Set<string>>();
  for (const message of input.snapshotMessages) {
    if (input.unreadConversationIds[message.target] !== message.conversationId) continue;
    const keys = enumerated.get(message.target) ?? new Set<string>();
    keys.add(noticeMessageKey(message));
    enumerated.set(message.target, keys);
  }
  const summaryOnly: [string, number][] = [];
  for (const [target, count] of Object.entries(unreadSummary)) {
    const remaining = count - (enumerated.get(target)?.size ?? 0);
    if (remaining > 0 && isDeliveryTarget(target)) summaryOnly.push([target, remaining]);
  }
  if (!recoveredTargets.size && !summaryOnly.length) return undefined;
  const countedByTarget = new Map<string, Map<string, NoticeMessage>>();
  for (const message of input.countedDeliveries ?? []) {
    if (!message.target || !isOrdinaryNotice(message)) continue;
    const counted = countedByTarget.get(message.target) ?? new Map<string, NoticeMessage>();
    counted.set(noticeMessageKey(message), message);
    countedByTarget.set(message.target, counted);
  }
  const acceptedMessages: NoticeMessage[] = [...recoveredMessages];
  for (const [target, count] of summaryOnly) {
    const counted = countedByTarget.get(target);
    if (counted && counted.size <= count) acceptedMessages.push(...counted.values());
  }
  const announced = new Set([...recoveredTargets, ...summaryOnly.map(([target]) => target)]);
  const notice = composeRecoveryNotice({
    agentId,
    announced: recoveredMessages,
    summaryOnly,
    openTasks: input.openTasks,
  });
  return { byTarget, recoveredMessages, acceptedMessages, announced, ...notice };
}
