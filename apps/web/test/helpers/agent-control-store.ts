import type { AgentControlAgent, AgentControlStore } from "#src/server/agents/agent-control.server";

/** The runtime config the pending-operation fixtures share. */
export const pendingRuntimeConfig = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/** A CAS-fenced `AgentControlStore` over one Agent, for tests that start from a hand-built
 * `AgentControlState`. */
export function pendingOpStore(initial: AgentControlAgent) {
  let agent = initial;
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(agent),
    replace: async (before, state) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  return { store, current: () => agent };
}
