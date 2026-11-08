import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentRuntimeConfig, AgentSession } from "@coforge/agent";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";

/** A session whose teardown fails as often as `failures` says, then succeeds. */
function failingTeardown(failures: number | "always") {
  const exitListeners = new Set<() => void>();
  return {
    disposeCalls: 0,
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    exit() {
      for (const listener of exitListeners) listener();
    },
    async dispose() {
      this.disposeCalls += 1;
      if (failures === "always" || this.disposeCalls <= failures)
        throw new AgentProcessCleanupError();
      this.exit();
    },
  } satisfies AgentSession & { disposeCalls: number; exit(): void };
}

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
const workspaceRoot = join(tmpdir(), `coforge-stop-failure-${crypto.randomUUID()}`);

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

function managerFor(session: AgentSession, starts: { count: number }) {
  const adapter: CodeAgentProvider = {
    provider: "pi",
    async createAgentSession() {
      starts.count += 1;
      return session;
    },
  };
  return new AgentProcessManager(() => adapter);
}

/** One Agent's start inputs; the directory is per-test so launches never share a workspace. */
function options(name: string) {
  return { agentWorkspaceDirectory: join(workspaceRoot, name, "agent-1") };
}

describe("a stop that cannot confirm process exit", () => {
  test("leaves a retryable state instead of a permanent stopping mark", async () => {
    const starts = { count: 0 };
    const session = failingTeardown(1);
    const manager = managerFor(session, starts);
    try {
      await manager.start("agent-1", config, options("retryable"));
      await expect(manager.stop("agent-1")).rejects.toBeInstanceOf(AgentProcessCleanupError);
      // The bug: the Agent reported stopping forever, muting its Activity and refusing Starts.
      expect(manager.isStopping("agent-1")).toBe(false);
      expect(manager.stopFailed("agent-1")).toBe(true);
      await manager.stop("agent-1");
      expect(manager.stopFailed("agent-1")).toBe(false);
      expect(manager.runningAgentIds()).toEqual([]);
    } finally {
      await manager.shutdown();
    }
  });

  test("refuses a Start while the old tree survives, naming the reason", async () => {
    const starts = { count: 0 };
    const session = failingTeardown("always");
    const manager = managerFor(session, starts);
    try {
      await manager.start("agent-1", config, options("survives"));
      await expect(manager.stop("agent-1")).rejects.toBeInstanceOf(AgentProcessCleanupError);
      // One Agent may never have two processes: the Start first re-clears the old tree, and
      // when that still fails nothing new is launched. The provider's own words ride the error.
      const refused = await manager.start("agent-1", config, options("survives")).catch((e) => e);
      expect(refused).toBeInstanceOf(AgentProcessCleanupError);
      expect((refused as AgentProcessCleanupError).detail).toBe(
        "code agent process tree did not exit",
      );
      expect(starts.count).toBe(1);
      expect(manager.stopFailed("agent-1")).toBe(true);
    } finally {
      // A shutdown that cannot confirm exit reports it rather than pretending it worked.
      await manager.shutdown().catch(() => undefined);
    }
  });

  test("launches once the Start's own re-clean confirms exit", async () => {
    const starts = { count: 0 };
    const session = failingTeardown(1);
    const manager = managerFor(session, starts);
    try {
      await manager.start("agent-1", config, options("reclean"));
      await expect(manager.stop("agent-1")).rejects.toBeInstanceOf(AgentProcessCleanupError);
      await manager.start("agent-1", config, options("reclean"));
      expect(session.disposeCalls).toBe(2);
      expect(starts.count).toBe(2);
      expect(manager.stopFailed("agent-1")).toBe(false);
      expect(manager.isStopping("agent-1")).toBe(false);
    } finally {
      await manager.shutdown();
    }
  });

  test("a Start during a genuine stop is still refused", async () => {
    const starts = { count: 0 };
    const session = failingTeardown(0);
    const manager = managerFor(session, starts);
    try {
      await manager.start("agent-1", config, options("in-flight"));
      const stopping = manager.stop("agent-1");
      await expect(manager.start("agent-1", config, options("in-flight"))).rejects.toThrow(
        "stopping",
      );
      await stopping;
      expect(starts.count).toBe(1);
    } finally {
      await manager.shutdown();
    }
  });

  test("a failed release leaves the Agent reachable, not stuck shutting down", async () => {
    const starts = { count: 0 };
    const session = failingTeardown(1);
    const manager = managerFor(session, starts);
    try {
      await manager.start("agent-1", config, options("release"));
      await expect(manager.release("agent-1", 1_000)).rejects.toBeInstanceOf(
        AgentProcessCleanupError,
      );
      // A release is not a Stop: the Agent is not left marked stopping, and its session is still
      // the live one, so what arrived during the release can still reach the process that stayed.
      expect(manager.isStopping("agent-1")).toBe(false);
      expect(manager.stopFailed("agent-1")).toBe(false);
      expect(manager.session("agent-1")).toBe(session);
      // That runtime is still registered, so a Start may not run beside it.
      await expect(manager.start("agent-1", config, options("release"))).rejects.toThrow(
        "already active",
      );
      expect(starts.count).toBe(1);
    } finally {
      await manager.shutdown().catch(() => undefined);
    }
  });

  test("a start whose own cleanup failed can be retried", async () => {
    let attempt = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        attempt += 1;
        // The provider's first launch dies the way a surviving process tree makes it die.
        if (attempt === 1) throw new AgentProcessCleanupError();
        return failingTeardown(0);
      },
    }));
    try {
      await expect(manager.start("agent-1", config, options("startup"))).rejects.toBeInstanceOf(
        AgentProcessCleanupError,
      );
      expect(manager.isStopping("agent-1")).toBe(false);
      // Nothing carries the Agent's launch tag any more, so the Start's re-clean confirms and
      // the user's retry is not refused forever.
      await manager.start("agent-1", config, options("startup"));
      expect(attempt).toBe(2);
      expect(manager.stopFailed("agent-1")).toBe(false);
    } finally {
      await manager.shutdown();
    }
  });
});
