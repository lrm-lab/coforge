import { deleteAgentWorkspace } from "./delete-agent-workspace";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { UpgradeResultReporter } from "./upgrade-result-reporter";
import type { DaemonConfig } from "./runtime";
import type {
  AgentWorkspaceDeleteRequest,
  AgentWorkspaceDeleteResult,
} from "@lrm/coforge-sdk/internal";
import {
  diagnosticErrorCode,
  parseUpgradeErrorCode,
  thrownMessage,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export async function requestUpgrade(
  requestUpgrade: ((requestId: string, expectedVersion?: string) => Promise<void>) | undefined,
  upgradeResults: UpgradeResultReporter,
  requestId: string,
  expectedVersion: string | undefined,
  workspaceId: string,
): Promise<void> {
  if (!requestUpgrade) throw new Error("upgrade requests are unsupported");
  try {
    await requestUpgrade(requestId, expectedVersion);
    void upgradeResults.report();
  } catch (error) {
    const message = thrownMessage(error);
    const errorCode = parseUpgradeErrorCode((error as { code?: unknown } | null)?.code);
    logger.warn("Computer upgrade request was refused", {
      event: "upgrade:request_refused",
      request_id: requestId,
      workspace_id: workspaceId,
      error_code: errorCode ?? diagnosticErrorCode(error),
      error_message: message,
    });
    await upgradeResults.reportRefused({
      requestId,
      status: "failed",
      completedAtMs: Date.now(),
      error: message,
      ...(errorCode ? { errorCode } : {}),
    });
    throw error;
  }
}

export async function deleteWorkspace(
  connection: DaemonConfig,
  request: Pick<AgentWorkspaceDeleteRequest, "agentId">,
  processManager: AgentProcessManager,
  stopAgent: (agentId: string) => Promise<void>,
  forget: (agentId: string) => void,
): Promise<Pick<AgentWorkspaceDeleteResult, "status">> {
  return deleteAgentWorkspace({
    agentId: request.agentId,
    agentWorkspaceDirectory: agentWorkspaceDirectory(
      connection.workspaceRoot,
      connection.workspaceId,
      request.agentId,
    ),
    isRunning: (agentId) =>
      Boolean(processManager.runtime(agentId)) || processManager.isStopping(agentId),
    stopAgent,
    forget,
  });
}
