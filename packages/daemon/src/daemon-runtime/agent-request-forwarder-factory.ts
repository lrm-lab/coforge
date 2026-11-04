import type { AgentContexts } from "./agent-contexts";
import { AgentRequestForwarder, type AgentRequestForwarderPorts } from "./agent-request-forwarder";

export function createAgentRequestForwarder(
  transport: () => AgentRequestForwarderPorts["transport"],
  connection: Readonly<{ workspaceId: string }>,
  contexts: Pick<AgentContexts, "ledger">,
  authorizedAgent: (context: string, agentApiKey: string | undefined) => string,
): AgentRequestForwarder {
  return new AgentRequestForwarder({
    get transport(): AgentRequestForwarderPorts["transport"] {
      return transport();
    },
    connection,
    contexts,
    authorizedAgent,
  });
}
