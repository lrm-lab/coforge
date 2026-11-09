import type { CodeAgentProviderFactory } from "#src/agent-runtime/agent-process-manager";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { FileConversationSessionStore } from "#src/persistence/conversation-session-store";
import { escapePathIdentity } from "#src/persistence/path-scope";

export function createAgentProcessManager(options: {
  createProvider: CodeAgentProviderFactory;
  stateDirectory: string;
  workspaceId: string;
  requestLogDirectory(agentId: string): string;
}): AgentProcessManager {
  return new AgentProcessManager(
    options.createProvider,
    undefined,
    (agentId) =>
      new FileConversationSessionStore(
        `${options.stateDirectory}/conversation-sessions/${escapePathIdentity(options.workspaceId)}/${escapePathIdentity(agentId)}.json`,
      ),
    options.requestLogDirectory,
  );
}
