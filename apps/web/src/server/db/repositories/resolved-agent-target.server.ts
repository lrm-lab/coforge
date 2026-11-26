import type { AgentConsumptionScope, AgentHistoryResponse } from "@lrm/coforge-sdk/agent";

/** An Agent-facing target (`#channel` or `@user`, optionally `:root`) resolved by `resolveAgentTarget`. */
export type ResolvedAgentTarget = {
  /** A task discussion's seat is a read-position convenience only — a resolved task_thread
   * reads with no seat at all, never refusing (task #522). */
  seatOptional?: boolean;
  conversationId: string;
  threadRootId: string | null;
  canonicalTarget: string;
  isChannel: boolean;
  isUserAgentDirectConversation?: boolean;
};

export function resolvedConsumptionScope(
  conversationId: string,
  threadRootId: string | null,
): AgentConsumptionScope {
  return threadRootId ? { conversationId, threadRootId } : { conversationId };
}

export function agentHistoryConsumptionScope(
  agentId: string,
  { conversationId, threadRootId, canonicalTarget, isChannel }: ResolvedAgentTarget,
  includeChannelScope?: boolean,
): AgentHistoryResponse["consumptionScope"] {
  const scope = resolvedConsumptionScope(conversationId, threadRootId);
  if (threadRootId) return { ...scope, agentId, channelType: "thread", target: canonicalTarget };
  if (!isChannel) return { ...scope, agentId, channelType: "dm", target: canonicalTarget };
  return includeChannelScope ? scope : undefined;
}
