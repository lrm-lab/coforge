import { AgentMessageOperations } from "./agent-message-operations";
import type { AgentMessageOperationsPorts } from "./agent-message-ports";

export function createAgentMessageOperations(
  ports: AgentMessageOperationsPorts,
): AgentMessageOperations {
  return new AgentMessageOperations(ports);
}
