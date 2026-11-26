import { z } from "zod";
import type { AgentMessageTransportResponse } from "./agent-http-clients";
import type { AgentHistoryConsumptionScope, AgentHistoryResponse } from "@lrm/coforge-sdk/agent";

const historyConsumptionScopeSchema = z.object({
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  channelType: z.enum(["dm", "thread"]),
  target: z.string().min(1),
});

/** Adapts the read route's response into the shape `DaemonRuntime` consumes. A boundary or a scope
 * that is not well formed is not trusted: a malformed or missing boundary reads as "no boundary"
 * (`null`), and a malformed scope is dropped. */
export function adaptAgentHistoryResponse(
  response: AgentHistoryResponse,
): AgentMessageTransportResponse {
  const boundary = validSequence(response.modelSeenUpToSeq);
  return {
    idempotencyKey: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messages: response.messages,
    hasOlder: response.hasOlder,
    hasNewer: response.hasNewer,
    olderCursor: response.olderCursor,
    newerCursor: response.newerCursor,
    modelSeenUpToSeq: boundary || null,
    unreadCursorBefore: validSequence(response.unreadCursorBefore),
    readPositionAfter: validSequence(response.readPositionAfter),
    moreUnread: response.moreUnread === true,
    consumptionScope: historyConsumptionScope(response.consumptionScope),
  };
}

function validSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function historyConsumptionScope(value: unknown): AgentHistoryConsumptionScope | undefined {
  const parsed = historyConsumptionScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
