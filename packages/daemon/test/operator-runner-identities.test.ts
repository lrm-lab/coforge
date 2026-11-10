import { expect, test } from "bun:test";
import type { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { operatorRunnerPorts } from "#src/daemon-runtime/operator-runner-identities";

test("operator runner ports read the current runtime and Workspace binding", async () => {
  let current: DaemonRuntime | undefined;
  let workspaceId: string | undefined;
  const stopped: string[] = [];
  const ports = operatorRunnerPorts(
    () => current,
    () => workspaceId,
  );

  expect(ports.runnerIdentities()).toEqual([]);
  await expect(ports.stopAgent("agent-a")).rejects.toThrow("daemon runtime is not running");

  const manager = {
    activeAgentIds: () => ["agent-a"],
    runningAgentIds: () => [],
    runtime: () => undefined,
    restartConfig: () => ({ config: { provider: "pi", model: "default" } }),
    isStopping: () => false,
  };
  current = {
    agentProcessManager: manager,
    stopAgent: async (agentId: string) => void stopped.push(agentId),
  } as unknown as DaemonRuntime;
  workspaceId = "workspace-a";

  expect(ports.runnerIdentities()).toEqual([
    {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      provider: "pi",
      model: "default",
      state: "idle",
    },
  ]);
  await ports.stopAgent("agent-a");
  expect(stopped).toEqual(["agent-a"]);
});
