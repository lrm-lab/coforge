import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";

/** What a save does with the Agent's runtime before it persists: `restart` stops it and starts it
 * again, `push` leaves it running and sends the Daemon the new configuration, `deferred` leaves a
 * stopped Agent for its next Start, `not-required` changes nothing the runtime reads. */
export type AgentConfigPlan = "not-required" | "deferred" | "restart" | "push";

/**
 * The control state a push was planned on, exactly as stored (`Agent.controlState`). The write
 * that persists the push holds the Agent's row lock, finds the control state still equal to this,
 * and re-fences it to the new configuration in the same transaction; a state that moved meanwhile
 * (Daemon reports do not take the runtime lock) throws `ControlFenceLostError` and writes nothing.
 */
export type ControlFence = { controlState: unknown };

export class ControlFenceLostError extends Error {
  constructor() {
    super("Agent control state changed before the configuration was saved");
    this.name = "ControlFenceLostError";
  }
}

export type AgentConfigChange = {
  changed: boolean;
  computerChanged?: boolean;
  /** The runtime provider changes: the control scope is bound to it, so it never pushes. */
  providerChanged?: boolean;
};

export type AgentConfigDecision = { plan: AgentConfigPlan; fence?: ControlFence };

/**
 * How a save of an Agent's runtime configuration (selection or environment)
 * reaches the Agent. `fence` is present when the Agent's latest control operation proves it is
 * running and its Daemon advertised `agent-config:v1`; a push also needs the Agent to stay on
 * its Computer and its provider.
 */
export function planAgentConfig(
  agent: Pick<AgentRecord, "computerId" | "stoppedAt">,
  change: AgentConfigChange,
  fence?: ControlFence,
): AgentConfigDecision {
  const computerChanged = change.computerChanged === true;
  if (!change.changed && !computerChanged) return { plan: "not-required" };
  // A stopped Agent has nothing running under the old configuration.
  if (agent.stoppedAt) return { plan: "deferred" };
  if (computerChanged || change.providerChanged === true || !agent.computerId || !fence)
    return { plan: "restart" };
  return { plan: "push", fence };
}
