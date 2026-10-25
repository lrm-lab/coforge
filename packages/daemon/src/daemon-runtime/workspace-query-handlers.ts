import type {
  AgentWorkspaceDeleteRequest,
  AgentWorkspaceDeleteResult,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentWorkspaceQueries } from "./agent-workspace-queries";
import type { DaemonConfig } from "./runtime";

type Queries = {
  connection: DaemonConfig;
  observations: Pick<AgentWorkspaceQueries, "listSkills" | "listFiles" | "readFile">;
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
      if (
        queries.isStopping() ||
        request.workspaceId !== connection.workspaceId ||
        request.computerId !== connection.computerId
      )
        return;
      const result = await queries.deleteWorkspace(request);
      if (!queries.isStopping() && queries.currentTransport() === transport)
        await transport.sendWorkspaceDeleteResult?.({ ...request, ...result });
    }),
  ];
}
