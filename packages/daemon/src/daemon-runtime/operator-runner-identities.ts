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
  runtime: () => DaemonRuntime | undefined,
  workspaceId: () => string | undefined,
) {
  return {
    hold: async (reason: import("@lrm/coforge-sdk/internal").RunnerHoldReason) => {
      const current = runtime();
      return {
        held: true,
        busyAgents: stampOperatorWorkspace(current?.holdRunners(reason), workspaceId() ?? ""),
      };
    },
    release: async () => {
      const current = runtime();
      return {
        held: false,
        busyAgents: stampOperatorWorkspace(current?.releaseRunners(), workspaceId() ?? ""),
      };
    },
    runnerIdentities: () => {
      const current = runtime();
      return operatorRunnerIdentities(current, workspaceId());
    },
    stopAgent: async (agentId: string) => {
      const current = runtime();
      if (!current) throw new Error("daemon runtime is not running");
      await current.stopAgent(agentId);
    },
  };
}

export function stampOperatorWorkspace<T extends object>(
  agents: readonly T[] | undefined,
  workspaceId: string,
) {
  return (agents ?? []).map((agent) => ({ ...agent, workspaceId }));
}
