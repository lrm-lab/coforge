import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentSession, AgentRuntimeConfig } from "@coforge/agent";

function sessionSpy() {
  const exitListeners = new Set<() => void>();
  return {
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async dispose() {
      for (const listener of exitListeners) listener();
    },
  } satisfies AgentSession;
}

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  reasoning: "balanced",
};
const testWorkspaceRoot = join(tmpdir(), `coforge-agent-manager-${crypto.randomUUID()}`);

afterAll(() => rm(testWorkspaceRoot, { recursive: true, force: true }));

test("replacing the restart runtime swaps the pushed fields and keeps the launch's own", async () => {
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      return sessionSpy();
    },
  }));
  const launch = { requestId: "start-owned", controlEpoch: 3, launchId: "launch-owned" };
  const launched: AgentRuntimeConfig = {
    ...config,
    modelProvider: "anthropic",
    fastMode: true,
    providerConfig: { kind: "coforge", providerId: "old" },
    toolProfile: "openviking-memory",
    envVars: { KEEP: "yes" },
  };
  try {
    await manager.start("agent-1", launched, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "replace-restart", "agent-1"),
      runtimeId: launch.launchId,
      sessionId: "session-1",
      serverLaunch: launch,
    });
    const runtime = manager.runtime("agent-1");
    manager.replaceRestartRuntime("agent-1", {
      provider: "pi",
      model: "new-model",
      modelProvider: "",
      reasoning: "high",
    });
    // The remembered config describes the next launch; the frozen live runtime is untouched.
    expect(manager.restartConfig("agent-1")).toEqual({
      config: {
        provider: "pi",
        model: "new-model",
        modelProvider: "",
        reasoning: "high",
        toolProfile: "openviking-memory",
        envVars: { KEEP: "yes" },
      },
      sessionId: "session-1",
      serverLaunch: launch,
    });
    expect("fastMode" in manager.restartConfig("agent-1")!.config).toBe(false);
    expect("providerConfig" in manager.restartConfig("agent-1")!.config).toBe(false);
    expect(manager.runtime("agent-1")).toBe(runtime);
    expect(runtime?.config.model).toBe("default");
  } finally {
    await manager.stop("agent-1");
  }
  // With nothing to replace it does nothing.
  manager.replaceRestartRuntime("agent-1", { provider: "pi", model: "x", reasoning: "high" });
  expect(manager.restartConfig("agent-1")).toBeUndefined();
});
