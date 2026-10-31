import type { AgentWorkspaceDeleteResult } from "@lrm/coforge-sdk/internal";
import {
  deleteAgentWorkspaceFiles,
  reportWorkspaceDeleteFailure,
} from "#src/agent-runtime/agent-workspace-files";

/**
 * Removes one Agent's workspace on this Computer: stop it when it still runs, forget what this
 * daemon kept for it, then delete the directory. A failure is classified here (`busy` when the
 * Agent would not stop) and logged with the Agent, so the dialog can name a cause.
 */
export function deleteAgentWorkspace(ports: {
  agentId: string;
  agentWorkspaceDirectory: string;
  isRunning(agentId: string): boolean;
  stopAgent(agentId: string): Promise<void>;
  forget(agentId: string): void;
}): Promise<Pick<AgentWorkspaceDeleteResult, "status">> {
  return (async () => {
    try {
      if (ports.isRunning(ports.agentId)) await ports.stopAgent(ports.agentId);
      ports.forget(ports.agentId);
      return await deleteAgentWorkspaceFiles({
        agentWorkspaceDirectory: ports.agentWorkspaceDirectory,
        agentId: ports.agentId,
      });
    } catch (error) {
      return { status: reportWorkspaceDeleteFailure(error, ports.agentId) };
    }
  })();
}
