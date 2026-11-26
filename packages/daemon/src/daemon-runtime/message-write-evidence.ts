import type { AgentConsumptionEvidence, AgentConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { AgentConsumedAttention } from "./agent-consumed-attention";
import { messageConsumptionKey, matchesConsumptionScope } from "./message-consumption-key";

function consumptionScopeForWrite(
  attention: AgentConsumedAttention,
  agentId: string,
  target: string,
): AgentConsumptionScope | undefined {
  attention.modelSeenSequence(agentId, target);
  const cursor = attention.peek(agentId, target);
  if (!cursor?.conversationId || !cursor.serverScope) return undefined;
  return {
    conversationId: cursor.conversationId,
    ...(cursor.threadRootId ? { threadRootId: cursor.threadRootId } : {}),
  };
}

function consumptionEvidenceForWrite(
  attention: AgentConsumedAttention,
  agentId: string,
  target: string,
  scope: AgentConsumptionScope | undefined,
): AgentConsumptionEvidence | undefined {
  if (!scope || !matchesConsumptionScope(target, scope)) return undefined;
  const seq = attention.modelSeenSequence(agentId, target, scope.conversationId);
  const cursor = attention.peek(agentId, target, scope.conversationId);
  if (
    !cursor?.serverScope ||
    messageConsumptionKey(scope.conversationId, target, cursor.threadRootId) !==
      messageConsumptionKey(scope.conversationId, target, scope.threadRootId)
  )
    return undefined;
  const exactSeqs = attention.seenExactSequences(agentId, target, scope.conversationId);
  if (seq === 0 && exactSeqs.length === 0) return undefined;
  return [
    {
      target: scope,
      entry: {
        ...(seq > 0 ? { seq } : {}),
        ...(exactSeqs.length > 0 ? { exactSeqs } : {}),
      },
    },
  ];
}

export function scopedWriteContext(
  attention: AgentConsumedAttention,
  agentId: string,
  target: string,
  override?: AgentConsumptionScope,
) {
  const scope = override ?? consumptionScopeForWrite(attention, agentId, target);
  return { scope, evidence: consumptionEvidenceForWrite(attention, agentId, target, scope) };
}
