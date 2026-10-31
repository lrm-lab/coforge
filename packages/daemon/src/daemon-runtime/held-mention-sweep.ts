import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentInputDrain } from "./agent-input-drain";

/**
 * The tracked mentions a runner hold kept for an Agent that has no session and no launch in
 * flight: they name a launch that is gone, so each is settled now rather than left queued.
 */
export function dropHeldMentionsWithoutSession(ports: {
  inputDrain: Pick<AgentInputDrain, "entries">;
  hasSession(agentId: string): boolean;
  hasLaunch(agentId: string): boolean;
  /** Settles one mention as terminal; false when the mention was not this sweep's to drop. */
  dropMention(message: AgentMessageDelivery): boolean;
}): void {
  for (const [agentId, queue] of ports.inputDrain.entries()) {
    if (ports.hasSession(agentId) || ports.hasLaunch(agentId)) continue;
    queue.items = queue.items.filter((item) => {
      if (item.kind !== "delivery" || !ports.dropMention(item.message)) return true;
      item.completion.resolve();
      return false;
    });
  }
}
