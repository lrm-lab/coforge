import type { ManagedRunnerIdentity } from "@lrm/coforge-sdk/internal";
import type { LocalDaemonLauncher } from "#src/daemon-host/launcher";

export function runnerCommandPort(input: {
  observe: () => Promise<Array<{ workspaceId: string; processId: number }>>;
  childClient: (workspaceId: string) => Pick<LocalDaemonLauncher, "runners">;
}) {
  return (
    operation: "list" | "stop",
    workspaceId: string | undefined,
    agentId: string | undefined,
  ) => runRunnerCommand({ ...input, operation, workspaceId, agentId });
}

export async function runRunnerCommand(input: {
  operation: "list" | "stop";
  workspaceId: string | undefined;
  agentId: string | undefined;
  observe: () => Promise<Array<{ workspaceId: string; processId: number }>>;
  childClient: (workspaceId: string) => Pick<LocalDaemonLauncher, "runners">;
}): Promise<ManagedRunnerIdentity[]> {
  if (input.operation === "stop" && !input.workspaceId)
    throw new Error("runner stop requires a Workspace and Agent id");
  const observed = await input.observe();
  const targets = input.workspaceId
    ? observed.some((runtime) => runtime.workspaceId === input.workspaceId && runtime.processId > 0)
      ? [input.workspaceId]
      : []
    : observed.filter((runtime) => runtime.processId > 0).map((runtime) => runtime.workspaceId);
  const results = await Promise.all(
    targets.map((id) => input.childClient(id).runners!(input.operation, input.agentId)),
  );
  return results.flat();
}
