import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeConfig, AgentSession } from "@coforge/agent";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { runnerIdentities } from "#src/agent-runtime/runner-identities";

const root = join(tmpdir(), `coforge-runner-view-${crypto.randomUUID()}`);
const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
afterAll(() => rm(root, { recursive: true, force: true }));

function session(): AgentSession {
  const listeners = new Set<(event: never) => void>();
  return {
    hasLiveTurn: false,
    sendMessage: async () => {},
    subscribe(listener) {
      listeners.add(listener as (event: never) => void);
      return () => listeners.delete(listener as (event: never) => void);
    },
    interrupt: async () => {},
    dispose: async () => {},
    onExit: () => () => {},
  };
}

test("operator runner identities omit provider credentials and clear after stop", async () => {
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      return session();
    },
  }));
  try {
    await manager.start(
      "agent-operator",
      { ...config, model: "model-a" },
      {
        agentWorkspaceDirectory: join(root, "agent-operator"),
        serverLaunch: { requestId: "request", controlEpoch: 1, launchId: "launch" },
        sessionId: "session",
      },
    );
    expect(runnerIdentities(manager)).toEqual([
      {
        agentId: "agent-operator",
        provider: "pi",
        model: "model-a",
        state: "running",
        launchId: "launch",
        sessionId: "session",
        hasLiveTurn: false,
      },
    ]);
    await manager.stop("agent-operator");
    expect(runnerIdentities(manager)).toEqual([]);
  } finally {
    await manager.shutdown();
  }
});
