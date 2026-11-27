import { agentReadConfirmResponseSchema } from "@lrm/coforge-sdk/agent";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { matchesConsumptionScope } from "./message-consumption-key";

export async function settleAgentReadConfirmation(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  const payload: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const parsed = agentReadConfirmResponseSchema.safeParse(payload);
  const confirmation = parsed.success ? parsed.data.confirmation : undefined;
  if (!confirmation) return response;
  const { scope, readThrough } = confirmation;
  if (scope.agentId !== agentId || !matchesConsumptionScope(scope.target, scope)) return response;
  const legacyAttentionScope = {
    ...scope,
    channelType: scope.channelType === "channel" ? ("dm" as const) : scope.channelType,
  };
  attention.recordHistoryRead(agentId, {
    spelling: scope.target,
    target: scope.target,
    shown: [],
    through: readThrough,
    scope: legacyAttentionScope,
  });
  return response;
}
