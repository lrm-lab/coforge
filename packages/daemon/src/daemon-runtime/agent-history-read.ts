import { z } from "zod";
import type { AgentMessageTransportResponse } from "#src/connection/agent-http-clients";
import {
  historyConsumptionScopeSchema,
  historySequenceSchema,
} from "#src/connection/agent-history-response";
import type { LocalAgentMessageRequest } from "@lrm/coforge-sdk/internal";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { matchesConsumptionScope } from "./message-consumption-key";
import { foldShownMessages } from "./unread-fold";

type HistoryRead = Readonly<{
  request: LocalAgentMessageRequest;
  result: AgentMessageTransportResponse;
  /** No `--before`, `--after` or `--around`: with `unread` the read looked at what is unread now,
   * and without it at the newest page. */
  unpaged: boolean;
}>;

const forwardedReadSchema = z.object({
  consumptionScope: historyConsumptionScopeSchema,
  messages: z.array(z.object({ target: z.string(), sequence: historySequenceSchema })),
  modelSeenUpToSeq: historySequenceSchema.optional().catch(undefined),
});

export function historyConsumptionTarget(
  agentId: string,
  requestedTarget: string,
  result: AgentMessageTransportResponse | undefined,
) {
  const receipt = result?.consumptionScope;
  const scope =
    receipt?.agentId === agentId &&
    receipt.conversationId &&
    receipt.target &&
    matchesConsumptionScope(receipt.target, receipt)
      ? receipt
      : undefined;
  return { scope, target: scope?.target ?? requestedTarget };
}

function recordHistoryRead(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  requestedTarget: string,
  { request, result, unpaged }: HistoryRead,
): void {
  const { scope, target } = historyConsumptionTarget(agentId, requestedTarget, result);
  const shown: number[] = [];
  let visibleSequence = 0;
  for (const message of result.messages)
    if (message.target === target) {
      if (scope) shown.push(message.sequence);
      if (message.sequence > visibleSequence) visibleSequence = message.sequence;
    }
  const boundary = request.around ? 0 : (result.modelSeenUpToSeq ?? 0);
  attention.noticeActionClocks.noteAgentAction(agentId);
  attention.recordHistoryRead(agentId, {
    spelling: requestedTarget,
    target,
    shown,
    through: scope ? boundary : 0,
    review:
      !request.around &&
      (boundary > 0 || result.messages.length === 0 || (unpaged && !request.unread))
        ? { sequence: visibleSequence }
        : undefined,
    scope,
  });
}

export function settleHistoryRead(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  requestedTarget: string,
  read: HistoryRead,
) {
  const { scope, target } = historyConsumptionTarget(agentId, requestedTarget, read.result);
  const page =
    read.request.unread && scope
      ? foldShownMessages(attention, agentId, target, scope.conversationId, read.result.messages)
      : { messages: read.result.messages, folded: undefined };
  recordHistoryRead(attention, agentId, requestedTarget, read);
  return page;
}

export function settleForwardedTaskRead(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  query: Record<string, string> | undefined,
  result: unknown,
) {
  const receipt = forwardedReadSchema.safeParse(result);
  if (!receipt.success) return;
  const page = receipt.data;
  const scope = page.consumptionScope;
  if (scope.agentId !== agentId || !matchesConsumptionScope(scope.target, scope)) return;
  const shown: number[] = [];
  for (const message of page.messages)
    if (message.target === scope.target) shown.push(message.sequence);
  attention.noticeActionClocks.noteAgentAction(agentId);
  attention.recordHistoryRead(agentId, {
    spelling: scope.target,
    target: scope.target,
    shown,
    through: query?.around ? 0 : (page.modelSeenUpToSeq ?? 0),
    review: undefined,
    scope,
  });
}

/** Distinct messages in a delivery list. The same message can appear more than once, only under
 * different deliveryIds: a redelivery arriving after the dedupe window is a second delivery of one
 * message. A notice counts messages. */
export function countDistinctMessages(deliveries: readonly { messageId: string }[]): number {
  return new Set(deliveries.map((delivery) => delivery.messageId)).size;
}
