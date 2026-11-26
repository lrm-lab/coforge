import type { AgentConsumptionEvidence } from "@lrm/coforge-sdk/agent";
import type { AgentConsumedAttention } from "./agent-consumed-attention";

export function consumptionEvidenceForWrite(
  attention: AgentConsumedAttention,
  agentId: string,
  target: string,
): AgentConsumptionEvidence | undefined {
  const seq = attention.modelSeenSequence(agentId, target);
  const cursor = attention.peek(agentId, target);
  if (!cursor?.conversationId || !cursor.serverScope) return undefined;
  const exactSeqs = attention.seenExactSequences(agentId, target, cursor.conversationId);
  if (seq === 0 && exactSeqs.length === 0) return undefined;
  return [
    {
      target: {
        conversationId: cursor.conversationId,
        ...(cursor.threadRootId ? { threadRootId: cursor.threadRootId } : {}),
      },
      entry: {
        ...(seq > 0 ? { seq } : {}),
        ...(exactSeqs.length > 0 ? { exactSeqs } : {}),
      },
    },
  ];
}
