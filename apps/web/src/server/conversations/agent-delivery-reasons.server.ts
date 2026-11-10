/** Why an active Agent member was outside the audience for one message. */
export type AgentDeliveryBlockerReason = "channel_muted" | "thread_unfollowed";

export type AgentDeliveryBlocker = {
  id: string;
  reason: AgentDeliveryBlockerReason;
};

export type AgentDeliveryAudience = ReadonlySet<string>;

type AgentMember = {
  agentId: string;
  notificationLevel: string;
};

type DeliveryMessage = {
  threadRootId: string | null;
  hasAgentMention: boolean;
};

type UnfollowRecord = {
  agentId: string;
  rootMessageId: string;
};

/**
 * Explains only delivery exclusions whose reason is durable and user-visible. `audience` must be
 * the result of the real channel delivery selector (`channelAgentRecipients`); keeping that as an
 * input makes this function a complement-and-label step rather than a second audience rule.
 */
export function agentDeliveryBlockers(input: {
  message: DeliveryMessage;
  agents: readonly AgentMember[];
  audience: AgentDeliveryAudience;
  seenAgentIds: readonly string[];
  hasActiveCoordinator: boolean;
  unfollowed: readonly UnfollowRecord[];
}): AgentDeliveryBlocker[] {
  const seen = new Set(input.seenAgentIds);
  const unfollowed = new Set(
    input.unfollowed
      .filter((record) => record.rootMessageId === input.message.threadRootId)
      .map((record) => record.agentId),
  );
  return input.agents.flatMap((agent): AgentDeliveryBlocker[] => {
    if (seen.has(agent.agentId) || input.audience.has(agent.agentId)) return [];
    if (
      input.message.threadRootId === null &&
      !input.message.hasAgentMention &&
      !input.hasActiveCoordinator &&
      agent.notificationLevel === "muted"
    ) {
      return [{ id: agent.agentId, reason: "channel_muted" as const }];
    }
    if (input.message.threadRootId !== null && unfollowed.has(agent.agentId)) {
      return [{ id: agent.agentId, reason: "thread_unfollowed" as const }];
    }
    return [];
  });
}
