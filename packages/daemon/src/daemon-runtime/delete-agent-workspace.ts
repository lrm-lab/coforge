import type { AgentWorkspaceDeleteResult } from "@lrm/coforge-sdk/internal";
import {
  deleteAgentWorkspaceFiles,
  reportWorkspaceDeleteFailure,
} from "#src/agent-runtime/agent-workspace-files";

/**
 * Removes one Agent's workspace on this Computer: stop it when it still runs, forget what this
 * daemon kept for it, then delete the directory. An Agent that will not stop is `busy`; a failed
 * deletion is classified by its errno. Every failure is logged with the Agent, so the dialog can
 * name a cause.
 */
export function deleteAgentWorkspace(ports: {
  agentId: string;
  agentWorkspaceDirectory: string;
  isRunning(agentId: string): boolean;
  stopAgent(agentId: string): Promise<void>;
  forget(agentId: string): void;
}): Promise<Pick<AgentWorkspaceDeleteResult, "status">> {
  return (async () => {
    if (ports.isRunning(ports.agentId)) {
      try {
        await ports.stopAgent(ports.agentId);
      } catch (error) {
        // An Agent that will not stop still holds its workspace: busy, whatever the error was
        // (a timeout or a refused signal carries no errno), not a generic failure.
        reportWorkspaceDeleteFailure(error, ports.agentId, "busy");
        return { status: "busy" };
      }
    }
    try {
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
