import type { ManagedRunnerIdentity } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "./agent-process-manager";

/** Builds the operator view without exposing provider credentials or Agent capabilities. */
export function runnerIdentities(
  manager: Pick<
    AgentProcessManager,
    "activeAgentIds" | "runningAgentIds" | "runtime" | "restartConfig" | "isStopping"
  >,
): Omit<ManagedRunnerIdentity, "workspaceId">[] {
  const ids = new Set([...manager.activeAgentIds(), ...manager.runningAgentIds()]);
  return [...ids].sort().flatMap((agentId) => {
    const runtime = manager.runtime(agentId);
    const restart = manager.restartConfig(agentId);
    const config = runtime?.config ?? restart?.config;
    if (!config) return [];
    return [
      {
        agentId,
        provider: config.provider,
        model: config.model,
        state: manager.isStopping(agentId)
          ? ("stopping" as const)
          : runtime
            ? ("running" as const)
            : ("idle" as const),
        ...(restart?.serverLaunch?.launchId ? { launchId: restart.serverLaunch.launchId } : {}),
        ...(restart?.sessionId ? { sessionId: restart.sessionId } : {}),
        ...(runtime?.session.hasLiveTurn !== undefined
          ? { hasLiveTurn: runtime.session.hasLiveTurn }
          : {}),
      },
    ];
  });
}
