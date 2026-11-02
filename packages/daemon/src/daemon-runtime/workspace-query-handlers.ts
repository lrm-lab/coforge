import type {
  AgentWorkspaceDeleteRequest,
  AgentWorkspaceDeleteResult,
  AgentWorkspaceScanRequest,
  AgentWorkspaceScanResult,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentWorkspaceQueries } from "./agent-workspace-queries";
import type { DaemonConfig } from "./runtime";

const logger = getLogger(["coforge", "daemon", "workspace"]);

type Queries = {
  connection: DaemonConfig;
  observations: Pick<AgentWorkspaceQueries, "listSkills" | "listFiles" | "readFile" | "scan">;
  deleteWorkspace(
    request: AgentWorkspaceDeleteRequest,
  ): Promise<Pick<AgentWorkspaceDeleteResult, "status">>;
  currentTransport(): DaemonConnectionClient;
  isStopping(): boolean;
};

/** Scoped workspace queries answer only through the transport that received them. */
export function subscribeWorkspaceQueries(
  transport: DaemonConnectionClient,
  queries: Queries,
): ((() => void) | undefined)[] {
  const { connection } = queries;
  return [
    transport.onSkillsList?.(async (request) => {
      if (
        queries.isStopping() ||
        request.workspaceId !== connection.workspaceId ||
        request.computerId !== connection.computerId
      )
        return;
      const result = await queries.observations.listSkills(connection, request);
      if (!queries.isStopping() && queries.currentTransport() === transport)
        await transport.sendSkillsListResult?.({
          ...request,
          ...result,
          scannedAtMs: Date.now(),
        });
    }),
    transport.onWorkspaceFilesList?.(async (request) => {
      if (
        queries.isStopping() ||
        request.workspaceId !== connection.workspaceId ||
        request.computerId !== connection.computerId
      )
        return;
      const result = await queries.observations.listFiles(connection, request);
      if (!queries.isStopping() && queries.currentTransport() === transport)
        await transport.sendWorkspaceFilesListResult?.({ ...request, ...result });
    }),
    transport.onWorkspaceScan?.(async (request: AgentWorkspaceScanRequest) => {
      if (
        queries.isStopping() ||
        request.workspaceId !== connection.workspaceId ||
        request.computerId !== connection.computerId
      )
        return;
      const result: Pick<AgentWorkspaceScanResult, "workspaces"> = await queries.observations.scan(
        connection,
        request,
      );
      if (!queries.isStopping() && queries.currentTransport() === transport)
        await transport.sendWorkspaceScanResult?.({ ...request, ...result });
    }),
    transport.onWorkspaceFileRead?.(async (request) => {
      if (
        queries.isStopping() ||
        request.workspaceId !== connection.workspaceId ||
        request.computerId !== connection.computerId
      )
        return;
      const result = await queries.observations.readFile(connection, request);
      if (!queries.isStopping() && queries.currentTransport() === transport)
        await transport.sendWorkspaceFileReadResult?.({ ...request, ...result });
    }),
    transport.onWorkspaceDelete?.(async (request) => {
      const scope = {
        agent_id: request.agentId,
        request_id: request.requestId,
      };
      // A deletion leaves this log line before anything can throw: without it a request that
      // never reaches the handler and one that fails inside look identical (task #367).
      logger.info("Workspace deletion request received", {
        event: "workspace_delete:received",
        ...scope,
        outcome: "received",
      });
      if (
        queries.isStopping() ||
        request.workspaceId !== connection.workspaceId ||
        request.computerId !== connection.computerId
      ) {
        logger.warning("Workspace deletion request ignored", {
          event: "workspace_delete:ignored",
          ...scope,
          stopping: queries.isStopping(),
          outcome: "ignored",
        });
        return;
      }
      const result = await queries.deleteWorkspace(request);
      logger.info("Workspace deletion finished", {
        event: "workspace_delete:result",
        ...scope,
        status: result.status,
        outcome: "ok",
      });
      if (!queries.isStopping() && queries.currentTransport() === transport) {
        try {
          await transport.sendWorkspaceDeleteResult?.({ ...request, ...result });
        } catch (error) {
          logger.warning("Workspace deletion result was not delivered", {
            event: "workspace_delete:result_send_failed",
            ...scope,
            status: result.status,
            error_code: error instanceof Error ? error.name : "unknown",
            outcome: "failed",
          });
        }
      }
    }),
  ];
}
