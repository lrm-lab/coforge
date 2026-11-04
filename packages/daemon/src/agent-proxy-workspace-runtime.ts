import type { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";
import type { AgentProxyRuntime } from "./agent-proxy-runtime";

/** The proxy's workspace-scoped handlers — the Manual, users, profiles and labels — each
 * reaching the forwarder when the request arrives. */
export const workspaceRuntime = (agentApi: () => AgentRequestForwarder) =>
  ({
    manualGet: async (...args) => agentApi().manualGet(...args),
    manualSearch: async (...args) => agentApi().manualSearch(...args),
    userInfo: async (...args) => agentApi().userInfo(...args),
    profileShow: async (...args) => agentApi().profileShow(...args),
    profileUpdate: async (...args) => agentApi().profileUpdate(...args),
    labelList: async (...args) => agentApi().labelList(...args),
    agentLabel: async (...args) => agentApi().agentLabel(...args),
  }) satisfies Partial<AgentProxyRuntime>;
