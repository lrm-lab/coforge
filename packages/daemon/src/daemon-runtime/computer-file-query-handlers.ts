import type { ComputerFilePullRequest } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { pullComputerFile } from "#src/computer-files/computer-file-pull";

type Queries = {
  connection: { workspaceId: string; computerId: string; workspaceRoot: string };
  currentTransport(): DaemonConnectionClient;
  isStopping(): boolean;
};

/** Owner authorization is enforced by Web; this binds each accepted pull to this connection. */
export function subscribeComputerFileQueries(
  transport: DaemonConnectionClient,
  queries: Queries,
): ((() => void) | undefined)[] {
  const accepts = (request: { workspaceId: string; computerId: string }) =>
    !queries.isStopping() &&
    request.workspaceId === queries.connection.workspaceId &&
    request.computerId === queries.connection.computerId;

  return [
    transport.onComputerFilePull?.(async (request: ComputerFilePullRequest) => {
      if (!accepts(request)) return;
      const result = await pullComputerFile(request, {
        workspaceRoot: queries.connection.workspaceRoot,
      });
      if (accepts(request) && queries.currentTransport() === transport)
        await transport.sendComputerFilePullResult?.(result);
    }),
  ];
}
