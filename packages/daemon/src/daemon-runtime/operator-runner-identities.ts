import type { ManagedRunnerIdentity } from "@lrm/coforge-sdk/internal";
import type { DaemonRuntime } from "./runtime";
import { runnerIdentities as buildRunnerIdentities } from "#src/agent-runtime/runner-identities";

export function operatorRunnerIdentities(
  runtime: DaemonRuntime | undefined,
  workspaceId: string | undefined,
): ManagedRunnerIdentity[] {
  return runtime && workspaceId
    ? buildRunnerIdentities(runtime.agentProcessManager).map((runner) => ({
        ...runner,
        workspaceId,
      }))
    : [];
}

export function operatorRunnerPorts(
  runtime: DaemonRuntime | undefined,
  workspaceId: string | undefined,
) {
  return {
    hold: async (reason: import("@lrm/coforge-sdk/internal").RunnerHoldReason) => ({
      held: true,
      busyAgents: stampOperatorWorkspace(runtime?.holdRunners(reason), workspaceId ?? ""),
    }),
    release: async () => ({
      held: false,
      busyAgents: stampOperatorWorkspace(runtime?.releaseRunners(), workspaceId ?? ""),
    }),
    runnerIdentities: () => operatorRunnerIdentities(runtime, workspaceId),
    stopAgent: async (agentId: string) => {
      if (!runtime) throw new Error("daemon runtime is not running");
      await runtime.stopAgent(agentId);
    },
  };
}

export function stampOperatorWorkspace<T extends object>(
  agents: readonly T[] | undefined,
  workspaceId: string,
) {
  return (agents ?? []).map((agent) => ({ ...agent, workspaceId }));
}
