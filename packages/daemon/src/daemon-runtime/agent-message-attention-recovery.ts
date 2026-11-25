import {
  AgentNoticeSuppressedError,
  type AgentConversationScope,
  type AgentSession,
} from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import type { AgentDeliveryQueue } from "./delivery-notice-writer";
import type { NoticeEligibility } from "./notice-eligibility";
import {
  isValidMessageSender,
  type AgentRecoveryMessage,
  type AgentStartOpenTasks,
} from "@lrm/coforge-sdk/internal";
import { composeRecoveryNotice } from "./agent-recovery-notice";
import {
  recordedDeliveryOutcome,
  type AttentionDecisionOutcome,
  type AttentionDecisionBasis,
  type AttentionReadBasis,
} from "./agent-message-attention-decision-log";
import { acceptNotice, type NoticeGeneration } from "./agent-wakeup-unavailable-error";
import type { MessageAttention } from "./agent-message-attention-index";
import { foldMessageAttention, isDeliveryTarget } from "./message-attention-fields";
import { isOrdinaryNotice, noticeMessageKey, type NoticeMessage } from "./accepted-message-notices";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type RecoveryPlan = Readonly<{
  byTarget: Map<string, MessageAttention>;
  recoveredMessages: readonly AgentRecoveryMessage[];
  acceptedMessages: readonly NoticeMessage[];
  announced: ReadonlySet<string>;
  notice: string;
  recoveredMessageCount: number;
  summaryUnreadCount: number;
  summaryOnly: readonly (readonly [string, number])[];
  summaryProof: ReadonlyMap<string, readonly NoticeMessage[]>;
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
  generation: NoticeGeneration;
  readBasis(agentId: string, message: AgentRecoveryMessage): AttentionReadBasis | undefined;
  alreadyNotified(message: AgentRecoveryMessage): boolean;
  decide(
    message: AgentRecoveryMessage,
    outcome: AttentionDecisionOutcome,
    basis?: AttentionDecisionBasis,
  ): void;
}): RecoveryPlan | undefined {
  const { agentId, messages, unreadSummary, decide, generation } = input;
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
    if (input.alreadyNotified(message)) {
      decide(message, "already_notified", "accepted_message");
      continue;
    }
    if (generation.seenMessageIds.has(message.messageId)) {
      decide(message, "already_notified");
      continue;
    }
    if (generation.seenDeliveryIds.has(message.deliveryId)) {
      decide(message, recordedDeliveryOutcome(generation, message.deliveryId));
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
  const summaryProof = new Map<string, readonly NoticeMessage[]>();
  for (const [target, count] of summaryOnly) {
    const counted = countedByTarget.get(target);
    if (!counted || counted.size > count) continue;
    const rows = [...counted.values()];
    acceptedMessages.push(...rows);
    const conversationId = input.unreadConversationIds[target] ?? rows[0]?.conversationId;
    if (
      counted.size === count &&
      rows.every(
        (message) =>
          message.conversationId === conversationId && Number.isSafeInteger(message.sequence),
      )
    )
      summaryProof.set(target, rows);
  }
  const announced = new Set([...recoveredTargets, ...summaryOnly.map(([target]) => target)]);
  const notice = composeRecoveryNotice({
    agentId,
    announced: recoveredMessages,
    summaryOnly,
    openTasks: input.openTasks,
  });
  return {
    byTarget,
    recoveredMessages,
    acceptedMessages,
    announced,
    summaryOnly,
    summaryProof,
    ...notice,
  };
}

export async function submitRecoveryNotice(input: {
  agentId: string;
  plan: RecoveryPlan | undefined;
  eligibility: NoticeEligibility;
  currentAttention(): ReadonlyMap<string, MessageAttention> | undefined;
  session: AgentSession;
  conversation?: AgentConversationScope;
  openTasks?: AgentStartOpenTasks;
  signal: AbortSignal;
  hold: Pick<AgentDeliveryQueue, "busy" | "noticeSettled">;
  sessionFor(agentId: string): AgentSession | undefined;
}): Promise<RecoveryPlan | undefined> {
  const { agentId, plan, eligibility } = input;
  if (!plan) return;
  const identity = { agent_id: agentId, attempt_id: crypto.randomUUID(), source: "recovery" };
  let selected: RecoveryPlan | undefined = plan;
  const refresh = (boundary: string) => {
    const mayWake = (message: NoticeMessage) =>
      message.sequence === undefined ||
      eligibility(agentId, { ...message, sequence: message.sequence }).disposition === "notify";
    const recoveredMessages = plan.recoveredMessages.filter(mayWake);
    const summaryOnly: [string, number][] = [];
    for (const [target, count] of plan.summaryOnly) {
      const pending = plan.summaryProof.get(target)?.filter(mayWake).length ?? count;
      if (pending) summaryOnly.push([target, pending]);
    }
    if (!recoveredMessages.length && !summaryOnly.length) selected = undefined;
    else {
      const byTarget = new Map(input.currentAttention());
      for (const message of recoveredMessages) foldMessageAttention(byTarget, message);
      const announced = new Set([
        ...recoveredMessages.map(({ target }) => target),
        ...summaryOnly.map(([target]) => target),
      ]);
      selected = {
        ...plan,
        byTarget,
        announced,
        recoveredMessages,
        summaryOnly,
        acceptedMessages: plan.acceptedMessages.filter(mayWake),
        ...composeRecoveryNotice({
          agentId,
          announced: recoveredMessages,
          summaryOnly,
          openTasks: input.openTasks,
        }),
      };
    }
    logger.info("Recovery notice submission decided", {
      ...identity,
      event: "agent.inbox_notice.submission_decision",
      boundary,
      outcome: selected ? "submit" : "suppress",
    });
    return selected?.notice;
  };
  input.hold.busy(agentId);
  try {
    await acceptNotice(input.signal, () => {
      const notice = refresh("admission");
      if (notice === undefined) throw new AgentNoticeSuppressedError();
      logger.info("Recovery notice handed to the session", {
        ...identity,
        event: "agent.inbox_notice.admission_requested",
      });
      return input.session.notify!(notice, {
        conversation: input.conversation,
        prepareSubmission: refresh,
        fallbackText: () => refresh("fallback"),
        onPromptWritten: () =>
          logger.info("ACP prompt written for recovery notice", {
            ...identity,
            event: "agent.inbox_notice.acp_prompt_written",
          }),
      });
    });
    return selected;
  } catch (error) {
    if (!(error instanceof AgentNoticeSuppressedError)) throw error;
    return undefined;
  } finally {
    if (input.sessionFor(agentId) === input.session) input.hold.noticeSettled?.(agentId);
  }
}
