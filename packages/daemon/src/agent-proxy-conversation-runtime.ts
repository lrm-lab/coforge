import type { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";
import type { AgentProxyRuntime } from "./agent-proxy-runtime";

/** The proxy's thread, inbox and task conversation handlers, each reaching the forwarder when the
 * request arrives. */
export const conversationRuntime = (agentApi: () => AgentRequestForwarder) =>
  ({
    threadList: async (...args) => agentApi().threadList(...args),
    inboxList: async (...args) => agentApi().inboxList(...args),
    agentTaskConversation: async (...args) => agentApi().agentTaskConversation(...args),
  }) satisfies Partial<AgentProxyRuntime>;
