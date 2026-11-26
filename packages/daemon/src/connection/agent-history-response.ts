import { z } from "zod";
import type { AgentMessageTransportResponse } from "./agent-http-clients";
import type { AgentHistoryResponse } from "@lrm/coforge-sdk/agent";
import { threadRootTarget } from "@lrm/coforge-sdk/internal";
import { agentConsumptionScopeSchema } from "@lrm/coforge-sdk/internal/agent-consumption";

export const historySequenceSchema = z.int().nonnegative();

export const historyConsumptionScopeSchema = agentConsumptionScopeSchema.extend({
  agentId: z.string().min(1),
  channelType: z.enum(["dm", "thread"]),
  target: z.string().min(1),
});

/** Adapts the read route's response into the shape `DaemonRuntime` consumes. A boundary or a scope
 * that is not well formed is not trusted: a malformed or missing boundary reads as "no boundary"
 * (`null`), and a malformed scope is dropped. */
export function adaptAgentHistoryResponse(
  response: Omit<AgentHistoryResponse, "consumptionScope"> & { consumptionScope?: unknown },
  request?: { agentId: string; target: string },
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
    consumptionScope: historyConsumptionScope(response.consumptionScope, request),
  };
}

function validSequence(value: unknown): number | undefined {
  const parsed = historySequenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function historyConsumptionScope(
  value: unknown,
  request?: { agentId: string; target: string },
): AgentMessageTransportResponse["consumptionScope"] {
  const legacy = historyConsumptionScopeSchema.safeParse(value);
  if (legacy.success) return legacy.data;
  if (!request?.target.startsWith("#") || threadRootTarget(request.target)) return undefined;
  const channel = agentConsumptionScopeSchema.safeParse(value);
  if (!channel.success || channel.data.threadRootId !== undefined) return undefined;
  return { ...channel.data, agentId: request.agentId, target: request.target, channelType: "dm" };
}
