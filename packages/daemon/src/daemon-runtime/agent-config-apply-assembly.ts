import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { AgentConfigApply } from "./agent-config-apply";
import type { RuntimeRelease } from "./runtime-release";

/** The `AgentConfigApply` construction `runtime.ts` reads as a call: the idle judgment and the
 * stop are `RuntimeRelease`'s, the wake config is the process manager's, and a launch in flight
 * is the runtime's `agentLaunches`. Each is a thunk because the collaborators are bound after the
 * field that holds this one initializes. */
export function assembleAgentConfigApply(input: {
  runtimeRelease(): Pick<RuntimeRelease<never>, "coldIdleAgent" | "stopForConfigApply">;
  processManager(): Pick<AgentProcessManager, "restartConfig" | "replaceRestartRuntime">;
  agentLaunches(): ReadonlyMap<string, unknown>;
  /** Each Agent's current launch, one object per launch (`currentActivityLaunches`). */
  activityLaunches(): ReadonlyMap<string, object>;
}): AgentConfigApply {
  return new AgentConfigApply({
    agent: (agentId) => input.runtimeRelease().coldIdleAgent(agentId),
    launching: (agentId) => input.agentLaunches().has(agentId),
    launchOf: (agentId) => input.activityLaunches().get(agentId),
    restartProvider: (agentId) => input.processManager().restartConfig(agentId)?.config.provider,
    replaceRestartRuntime: (agentId, fields) =>
      input.processManager().replaceRestartRuntime(agentId, fields),
    stopIdle: (agentId) => input.runtimeRelease().stopForConfigApply(agentId),
  });
}
