import type { ManagedRunnerIdentity } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { runnerIdentities as localRunnerIdentities } from "#src/agent-runtime/runner-identities";

export function runnerIdentities(
  manager: Pick<
    AgentProcessManager,
    "activeAgentIds" | "runningAgentIds" | "runtime" | "restartConfig" | "isStopping"
  >,
  workspaceId: string,
): ManagedRunnerIdentity[] {
  return localRunnerIdentities(manager).map((runner) => ({ ...runner, workspaceId }));
}
