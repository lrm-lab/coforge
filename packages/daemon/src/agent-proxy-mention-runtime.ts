import type { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";
import type { AgentProxyRuntime } from "./agent-proxy-runtime";

/** The proxy's @mention handlers, each reaching the forwarder when the request arrives. */
export const mentionRuntime = (agentApi: () => AgentRequestForwarder) =>
  ({
    mentionPending: async (...args) => agentApi().mentionPending(...args),
    mentionExecute: async (...args) => agentApi().mentionExecute(...args),
    mentionDelivery: async (...args) => agentApi().mentionDelivery(...args),
  }) satisfies Partial<AgentProxyRuntime>;
