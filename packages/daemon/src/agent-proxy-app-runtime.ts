import type { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";
import type { AgentProxyRuntime } from "./agent-proxy-runtime";

/** The proxy's App handlers (`coforge app config`, `coforge app ...`), each reaching the
 * forwarder when the request arrives. */
export const appRuntime = (agentApi: () => AgentRequestForwarder) =>
  ({
    appConfigGet: async (...args) => agentApi().appConfigGet(...args),
    appConfigUpdate: async (...args) => agentApi().appConfigUpdate(...args),
    agentApp: async (...args) => agentApi().agentApp(...args),
  }) satisfies Partial<AgentProxyRuntime>;
