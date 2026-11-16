import type { CodeAgentProviderFactory } from "#src/agent-runtime/agent-process-manager";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";

export function createAgentProcessManager(options: {
  createProvider: CodeAgentProviderFactory;
  stateDirectory: string;
  workspaceId: string;
  requestLogDirectory(agentId: string): string;
}): AgentProcessManager {
  return new AgentProcessManager(options.createProvider, undefined, options.requestLogDirectory);
}
