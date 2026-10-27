import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";

/** An Agent-facing target (`#channel` or `@user`, optionally `:root`) resolved by `resolveAgentTarget`. */
export type ResolvedAgentTarget = {
  conversationId: string;
  threadRootId: string | null;
  canonicalTarget: string;
  isChannel: boolean;
  isUserAgentDirectConversation?: boolean;
};

/** The `consumption_scope` of an Agent history read: which conversation it consumed, for
 * a direct conversation or a thread, whose target has more than one spelling. None for a channel's
 * top level. */
export function agentHistoryConsumptionScope(
  agentId: string,
  { conversationId, threadRootId, canonicalTarget, isChannel }: ResolvedAgentTarget,
): AgentHistoryConsumptionScope | undefined {
  if (threadRootId)
    return { agentId, conversationId, channelType: "thread", target: canonicalTarget };
  if (!isChannel) return { agentId, conversationId, channelType: "dm", target: canonicalTarget };
  return undefined;
}
