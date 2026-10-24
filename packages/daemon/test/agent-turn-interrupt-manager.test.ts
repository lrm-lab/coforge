import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentSession, AgentRuntimeConfig, AgentRuntimeEvent } from "@coforge/agent";

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
const root = join(tmpdir(), `coforge-interrupt-manager-${crypto.randomUUID()}`);

function session(hasLiveTurn = true): AgentSession {
  return {
    hasLiveTurn,
    async sendMessage() {},
    subscribe: () => () => {},
    async interrupt() {},
    onExit: () => () => {},
    async dispose() {},
  };
}

test("interrupts a live turn without releasing the runtime", async () => {
  let resolveInterrupt!: () => void;
  let emitCompleted!: () => void;
  let interrupted = false;
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const current = {
    ...session(),
    hasLiveTurn: true,
    subscribe(listener: (event: AgentRuntimeEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async interrupt() {
      await new Promise<void>((resolve) => {
        resolveInterrupt = () => {
          interrupted = true;
          resolve();
          emitCompleted();
        };
      });
    },
  } satisfies AgentSession & { hasLiveTurn: boolean };
  emitCompleted = () => {
    for (const listener of listeners) listener({ type: "completed", status: "interrupted" });
  };
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    createAgentSession: async () => current,
  }));
  try {
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(root, "live"),
      serverLaunch: { requestId: "start-1", controlEpoch: 1, launchId: "launch-1" },
    });
    const result = manager.interruptTurn("agent-1", {
      interruptTimeoutMs: 1_000,
      releaseTimeoutMs: 1_000,
    });
    resolveInterrupt();
    await expect(result).resolves.toBe("interrupted");
    expect(interrupted).toBe(true);
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
  } finally {
    await manager.shutdown();
  }
});

test("a timed-out interrupt releases the runtime but keeps its restart config", async () => {
  const current = {
    ...session(),
    hasLiveTurn: true,
    async interrupt() {
      await new Promise<void>(() => {});
    },
  } satisfies AgentSession & { hasLiveTurn: boolean };
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    createAgentSession: async () => current,
  }));
  try {
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(root, "timeout"),
      serverLaunch: { requestId: "start-2", controlEpoch: 2, launchId: "launch-2" },
    });
    await expect(
      manager.interruptTurn("agent-1", { interruptTimeoutMs: 1, releaseTimeoutMs: 100 }),
    ).resolves.toBe("restarted");
    expect(manager.runningAgentIds()).toEqual([]);
    expect(manager.serverLaunch("agent-1")).toMatchObject({ launchId: "launch-2" });
  } finally {
    await manager.shutdown();
  }
});
