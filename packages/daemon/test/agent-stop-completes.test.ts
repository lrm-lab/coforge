import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_STOP_DEADLINE_MS,
  AGENT_STOP_SWEEP_DEADLINE_MS,
  type AgentStopSettings,
} from "#src/agent-runtime/agent-stop";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentLaunchTagSweepReport } from "#src/platform/agent-launch-tag-sweep";
import type { AgentRuntimeConfig, AgentSession, AgentSessionExit } from "@coforge/agent";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";
import { captureDaemonLogs } from "./log-capture";

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
const workspaceRoot = join(tmpdir(), `coforge-stop-completes-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const DEADLINE_MS = 20;
const emptyReport: AgentLaunchTagSweepReport = {
  matched: 0,
  killed: 0,
  unkilled: [],
  durationMs: 0,
};

type FakeSession = AgentSession & { exit(exit?: AgentSessionExit): void; disposeCalls: number };

/** A session whose teardown is whatever `dispose` says; `exit` plays the provider's exit event. */
function fakeSession(dispose: (session: FakeSession) => Promise<void>): FakeSession {
  const listeners = new Set<(exit?: AgentSessionExit) => void>();
  const session: FakeSession = {
    disposeCalls: 0,
    async sendMessage() {},
    subscribe: () => () => undefined,
    async interrupt() {},
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exit(exit) {
      for (const listener of listeners) listener(exit);
    },
    async dispose() {
      session.disposeCalls += 1;
      await dispose(session);
    },
  };
  return session;
}

/** A manager over the sessions it is handed in order, with a fake sweep and short deadlines. */
function harness(
  sessions: FakeSession[],
  sweep: (agentId: string) => Promise<AgentLaunchTagSweepReport> = async () => emptyReport,
) {
  const swept: string[] = [];
  const settings: AgentStopSettings = {
    deadlineMs: DEADLINE_MS,
    sweepDeadlineMs: DEADLINE_MS,
    sweep: async (agentId) => {
      swept.push(agentId);
      return sweep(agentId);
    },
  };
  let created = 0;
  const manager = new AgentProcessManager(
    () => ({
      provider: "pi",
      async createAgentSession() {
        return sessions[created++]!;
      },
    }),
    undefined,
    undefined,
    undefined,
    settings,
  );
  const start = (name: string) =>
    manager.start("agent-1", config, { agentWorkspaceDirectory: join(workspaceRoot, name) });
  return { manager, swept, start, created: () => created };
}

const hangs = () => new Promise<void>(() => {});

describe("a stop always completes", () => {
  test("pins the production deadlines", () => {
    expect(AGENT_STOP_DEADLINE_MS).toBe(25_000);
    expect(AGENT_STOP_SWEEP_DEADLINE_MS).toBe(5_000);
  });

  test("a dispose that never resolves is abandoned at the deadline and the Agent is released", async () => {
    const { manager, swept, start } = harness([fakeSession(hangs)]);
    await start("hang");
    manager.rememberServerLaunch("agent-1", { requestId: "r", controlEpoch: 1, launchId: "l" });

    await manager.stop("agent-1");

    expect(manager.runningAgentIds()).toEqual([]);
    expect(manager.session("agent-1")).toBeUndefined();
    expect(manager.restartConfig("agent-1")).toBeUndefined();
    expect(manager.isStopping("agent-1")).toBe(false);
    expect(manager.status("agent-1")).toBe("inactive");
    expect(swept).toEqual(["agent-1"]);
  });

  test("an abandoned dispose is logged with why", async () => {
    const { manager, start } = harness([fakeSession(hangs)]);
    await start("log-forced");
    const { records } = await captureDaemonLogs(() => manager.stop("agent-1"));
    const forced = records.find((r) => r.properties.event === "agent_runtime:stop_forced");
    expect(forced?.level).toBe("warning");
    expect(forced?.properties).toMatchObject({ agent_id: "agent-1", reason: "timeout" });
  });

  test("a dispose that rejects ends the stop the same way", async () => {
    const failing = fakeSession(async () => {
      throw new AgentProcessCleanupError();
    });
    const { manager, swept, start } = harness([failing]);
    await start("reject");

    await expect(manager.stop("agent-1")).resolves.toBeUndefined();

    expect(manager.runningAgentIds()).toEqual([]);
    expect(swept).toEqual(["agent-1"]);
  });

  test("a clean dispose does not sweep", async () => {
    const clean = fakeSession(async (session) => session.exit());
    const { manager, swept, start } = harness([clean]);
    await start("clean");

    await manager.stop("agent-1");

    expect(swept).toEqual([]);
    expect(manager.status("agent-1")).toBe("inactive");
  });

  test("a process the sweep cannot kill is logged with its pids and does not fail the stop", async () => {
    const { manager, start } = harness([fakeSession(hangs)], async () => ({
      ...emptyReport,
      matched: 1,
      unkilled: [{ pid: 4242, reason: "still_alive" }],
    }));
    await start("survivor");

    const { records } = await captureDaemonLogs(() => manager.stop("agent-1"));

    const warning = records.find((r) => r.properties.event === "agent_runtime:stop_unconfirmed");
    expect(warning?.level).toBe("warning");
    expect(warning?.properties).toMatchObject({
      agent_id: "agent-1",
      survivors: [{ pid: 4242, reason: "still_alive" }],
    });
    expect(manager.runningAgentIds()).toEqual([]);
  });

  test("a sweep that never answers is bounded too", async () => {
    const { manager, start } = harness([fakeSession(hangs)], hangs as never);
    await start("hung-sweep");
    await expect(manager.stop("agent-1")).resolves.toBeUndefined();
    expect(manager.runningAgentIds()).toEqual([]);
  });

  test("the Start after an unconfirmed stop sweeps once more and then launches, survivors or not", async () => {
    const survivor = { ...emptyReport, unkilled: [{ pid: 7, reason: "still_alive" }] };
    const { manager, swept, start, created } = harness(
      [fakeSession(hangs), fakeSession(async (session) => session.exit())],
      async () => survivor,
    );
    await start("first");
    await manager.stop("agent-1");
    expect(swept).toHaveLength(1);

    await start("second");

    expect(created()).toBe(2);
    expect(swept).toHaveLength(2);
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
  });

  test("a Start whose sweep never answers launches after the bound", async () => {
    const { manager, start, created } = harness(
      [fakeSession(hangs), fakeSession(async (session) => session.exit())],
      hangs as never,
    );
    await start("first");
    await manager.stop("agent-1");
    await start("second");
    expect(created()).toBe(2);
  });

  test("a Start after a confirmed stop does not sweep", async () => {
    const { manager, swept, start } = harness([
      fakeSession(async (session) => session.exit()),
      fakeSession(async (session) => session.exit()),
    ]);
    await start("first");
    await manager.stop("agent-1");
    await start("second");
    expect(swept).toEqual([]);
  });

  test("a process that ended but left its tree is forgotten, and the next Start sweeps", async () => {
    const { manager, swept, start, created } = harness([
      fakeSession(async () => {}),
      fakeSession(async () => {}),
    ]);
    await start("first");
    (manager.session("agent-1") as FakeSession).exit({
      code: 1,
      signal: null,
      cleanupUnconfirmed: true,
    });
    expect(manager.runningAgentIds()).toEqual([]);
    expect(manager.session("agent-1")).toBeUndefined();

    await start("second");

    expect(created()).toBe(2);
    expect(swept).toEqual(["agent-1"]);
  });

  test("concurrent stops join one teardown and both complete", async () => {
    const gate = Promise.withResolvers<void>();
    const session = fakeSession(async (s) => {
      await gate.promise;
      s.exit();
    });
    const { manager, start } = harness([session]);
    await start("join");
    const first = manager.stop("agent-1");
    const second = manager.stop("agent-1");
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(session.disposeCalls).toBe(1);
  });

  test("a stop that arrives during a release joins it instead of throwing", async () => {
    const gate = Promise.withResolvers<void>();
    const session = fakeSession(async (s) => {
      await gate.promise;
      s.exit();
    });
    const { manager, start } = harness([session]);
    await start("during-release");
    const released = manager.release("agent-1", 1_000);
    const stopped = manager.stop("agent-1");
    gate.resolve();
    await released;
    await expect(stopped).resolves.toBeUndefined();
    expect(manager.runningAgentIds()).toEqual([]);
  });

  test("a release that arrives during a stop fails, so its caller does not relaunch", async () => {
    const gate = Promise.withResolvers<void>();
    const session = fakeSession(async (s) => {
      await gate.promise;
      s.exit();
    });
    const { manager, start } = harness([session]);
    await start("release-during-stop");
    const stopped = manager.stop("agent-1");
    await expect(manager.release("agent-1", 1_000)).rejects.toThrow("stopping");
    gate.resolve();
    await expect(stopped).resolves.toBeUndefined();
    expect(session.disposeCalls).toBe(1);
  });

  test("an abandoned session that fails or exits late never disturbs its replacement", async () => {
    const late = Promise.withResolvers<void>();
    const abandoned = fakeSession(() => late.promise);
    const replacement = fakeSession(async () => {});
    const { manager, start } = harness([abandoned, replacement]);
    await start("first");
    await manager.stop("agent-1");
    await start("second");

    abandoned.exit({ code: 0, signal: null });
    late.reject(new AgentProcessCleanupError());
    await Bun.sleep(DEADLINE_MS);

    expect(manager.session("agent-1")).toBe(replacement);
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
  });

  test("a failed release leaves the runtime registered and delivering", async () => {
    const failing = fakeSession(async () => {
      throw new AgentProcessCleanupError();
    });
    const { manager, start, created } = harness([failing]);
    await start("release");

    await expect(manager.release("agent-1", 1_000)).rejects.toBeInstanceOf(
      AgentProcessCleanupError,
    );

    expect(manager.isStopping("agent-1")).toBe(false);
    expect(manager.session("agent-1")).toBe(failing);
    await expect(start("release")).rejects.toThrow("already active");
    expect(created()).toBe(1);
  });

  test("a Start during a stop is refused until the stop completes", async () => {
    const gate = Promise.withResolvers<void>();
    const { manager, start } = harness([
      fakeSession(async (s) => {
        await gate.promise;
        s.exit();
      }),
      fakeSession(async () => {}),
    ]);
    await start("first");
    const stopping = manager.stop("agent-1");
    await expect(start("second")).rejects.toThrow("stopping");
    gate.resolve();
    await stopping;
    await start("second");
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
  });
});
