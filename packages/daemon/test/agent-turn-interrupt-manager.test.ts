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

test("a successful interrupt kills only the turn's descendants, best effort", async () => {
  const kills: { startedAfterMs: number; startedBeforeMs?: number }[] = [];
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
      for (const listener of listeners) listener({ type: "completed", status: "interrupted" });
    },
    async killTurnProcesses(window: { startedAfterMs: number; startedBeforeMs?: number }) {
      kills.push(window);
      if (kills.length === 1) throw new Error("descendant scan failed");
    },
  } satisfies AgentSession & { hasLiveTurn: boolean };
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    createAgentSession: async () => current,
  }));
  try {
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(root, "kill-window"),
      serverLaunch: { requestId: "start-3", controlEpoch: 3, launchId: "launch-3" },
    });
    // A cleanup failure must not turn the native interrupt into a restart.
    await expect(
      manager.interruptTurn("agent-1", {
        interruptTimeoutMs: 1_000,
        releaseTimeoutMs: 1_000,
        cutoffAtMs: 42_000,
      }),
    ).resolves.toBe("interrupted");
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
    expect(kills).toHaveLength(1);
    expect(kills[0]!.startedAfterMs).toBe(42_000);
    expect(kills[0]!.startedBeforeMs).toBeGreaterThan(0);
    await expect(
      manager.interruptTurn("agent-1", {
        interruptTimeoutMs: 1_000,
        releaseTimeoutMs: 1_000,
        cutoffAtMs: 42_000,
      }),
    ).resolves.toBe("interrupted");
    expect(kills).toHaveLength(2);
  } finally {
    await manager.shutdown();
  }
});

test("interruptSubagent reaches the session's per-task stop and reports unsupported", async () => {
  const seen: string[] = [];
  const current = {
    ...session(),
    hasLiveTurn: true,
    async interruptSubagent(taskId: string) {
      seen.push(taskId);
      return "interrupted" as const;
    },
  } satisfies AgentSession & { hasLiveTurn: boolean };
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    createAgentSession: async () => current,
  }));
  try {
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(root, "sub-stop"),
      serverLaunch: { requestId: "start-4", controlEpoch: 4, launchId: "launch-4" },
    });
    await expect(manager.interruptSubagent("agent-1", "task-7")).resolves.toBe("interrupted");
    expect(seen).toEqual(["task-7"]);
    await expect(manager.interruptSubagent("agent-9", "task-7")).resolves.toBe("not_running");
  } finally {
    await manager.shutdown();
  }

  const bare = new AgentProcessManager(() => ({
    provider: "pi",
    createAgentSession: async () => session(),
  }));
  try {
    await bare.start("agent-2", config, {
      agentWorkspaceDirectory: join(root, "sub-unsupported"),
      serverLaunch: { requestId: "start-5", controlEpoch: 5, launchId: "launch-5" },
    });
    await expect(bare.interruptSubagent("agent-2", "task-7")).resolves.toBe("unsupported");
  } finally {
    await bare.shutdown();
  }
});
