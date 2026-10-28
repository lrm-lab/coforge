import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CodeAgentProvider, SessionResumeFacts } from "@lrm/coforge-anvil";
import {
  ColdIdleSweep,
  idleBlocker,
  type AgentIdleFacts,
  type ColdIdleAgent,
  type IdleBlocker,
} from "#src/daemon-runtime/cold-idle-sweep";
import type { ColdIdleStop } from "#src/agent-runtime/wake-session-recycle";
import { captureDaemonLogs } from "./log-capture";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

const idleFacts: AgentIdleFacts = {
  memoryAgent: false,
  launched: true,
  hasLiveTurn: false,
  working: false,
  deliveriesQueued: false,
  inputsQueued: false,
  openToolCall: false,
  backgroundTasks: 0,
  launching: false,
  stopping: false,
  recoveringStalledRuntime: false,
  runnerHold: false,
  migrating: false,
};

test("an Agent is idle only when every guard of the daemon's own state holds", () => {
  expect(idleBlocker(idleFacts)).toBeUndefined();
  const blocked: Array<[Partial<AgentIdleFacts>, IdleBlocker]> = [
    [{ memoryAgent: true }, "memory_agent"],
    [{ launched: false }, "not_launched"],
    [{ launching: true }, "launching"],
    [{ stopping: true }, "stopping"],
    [{ recoveringStalledRuntime: true }, "stalled_recovery"],
    [{ runnerHold: true }, "runner_hold"],
    [{ migrating: true }, "migrating"],
    [{ hasLiveTurn: true }, "live_turn"],
    [{ hasLiveTurn: undefined }, "live_turn_unknown"],
    [{ working: true }, "working"],
    [{ deliveriesQueued: true }, "queued_delivery"],
    [{ inputsQueued: true }, "queued_input"],
    [{ openToolCall: true }, "open_tool_call"],
    [{ backgroundTasks: 2 }, "background_tasks"],
  ];
  for (const [override, reason] of blocked)
    expect(idleBlocker({ ...idleFacts, ...override })).toBe(reason);
});

const savedEnv = Bun.env.COFORGE_WAKE_RECYCLE_SWEEP_MS;
beforeEach(() => {
  delete Bun.env.COFORGE_WAKE_RECYCLE_SWEEP_MS;
});
afterEach(() => {
  if (savedEnv === undefined) delete Bun.env.COFORGE_WAKE_RECYCLE_SWEEP_MS;
  else Bun.env.COFORGE_WAKE_RECYCLE_SWEEP_MS = savedEnv;
});

/** Agents the sweep may see, the facts their sessions report, and the stops it asked for. */
function fixture(agents: Record<string, Partial<ColdIdleAgent>>, seam = true) {
  const state: Record<string, ColdIdleAgent> = {};
  for (const [agentId, override] of Object.entries(agents))
    state[agentId] = {
      agentId,
      provider: "claude-code",
      busyReason: undefined,
      sessionId: `session-${agentId}`,
      lastEventAtMs: NOW - 80 * MINUTE,
      ...override,
    };
  const facts: SessionResumeFacts = {
    lastActivityAtMs: NOW - 70 * MINUTE,
    lastContextTokens: 300_000,
  };
  const reads: string[] = [];
  const stops: ColdIdleStop[] = [];
  const provider = {
    provider: "claude-code",
    ...(seam
      ? {
          async readSessionResumeFacts(options: { sessionId: string }) {
            reads.push(options.sessionId);
            return facts;
          },
        }
      : {}),
  } as unknown as CodeAgentProvider;
  const sweep = new ColdIdleSweep({
    agentIds: () => Object.keys(state),
    agent: (agentId) => state[agentId],
    provider: () => provider,
    stop: async (stop) => void stops.push(stop),
    now: () => NOW,
  });
  return { state, sweep, reads, stops, facts };
}

test("a sweep stops each cold, idle, large Agent and logs a summary with its skip reasons", async () => {
  const { sweep, stops, state } = fixture({
    cold: {},
    busy: { busyReason: "open_tool_call" },
    recent: { lastEventAtMs: NOW - 10 * MINUTE },
    off: { envVars: { COFORGE_WAKE_RECYCLE: "0" } },
  });
  const { records } = await captureDaemonLogs(() => sweep.sweep());
  expect(stops).toEqual([
    {
      agentId: "cold",
      sessionId: "session-cold",
      idleMs: 70 * MINUTE,
      priorContextTokens: 300_000,
    },
  ]);
  const summary = records.find((r) => r.properties.event === "agent.runtime.cold_idle_sweep");
  expect(summary?.properties).toMatchObject({
    agents: 4,
    stops: 1,
    skipped_open_tool_call: 1,
    skipped_recent_event: 1,
    skipped_disabled: 1,
  });
  expect(state.cold).toBeDefined();
});

test("a provider without the seam is never stopped, and its session is never read", async () => {
  const { sweep, stops, reads } = fixture({ a: {} }, false);
  const { records } = await captureDaemonLogs(() => sweep.sweep());
  expect(stops).toEqual([]);
  expect(reads).toEqual([]);
  expect(
    records.find((r) => r.properties.event === "agent.runtime.cold_idle_sweep")?.properties,
  ).toMatchObject({ agents: 1, stops: 0, skipped_unsupported: 1 });
});

test("a sweep stops at the provider's cold gap when the 60 minute default would keep the session", async () => {
  const previousGap = Bun.env.COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS;
  delete Bun.env.COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS;
  const agent: ColdIdleAgent = {
    agentId: "codex",
    provider: "codex",
    busyReason: undefined,
    sessionId: "session-codex",
    lastEventAtMs: NOW - 31 * MINUTE,
  };
  const stops: ColdIdleStop[] = [];
  const provider = {
    provider: "codex",
    idleRecycleMinColdGapMs: 30 * MINUTE,
    async readSessionResumeFacts() {
      return { lastActivityAtMs: NOW - 31 * MINUTE, lastContextTokens: 200_000 };
    },
  } as unknown as CodeAgentProvider;
  const sweep = new ColdIdleSweep({
    agentIds: () => ["codex"],
    agent: () => agent,
    provider: () => provider,
    stop: async (stop) => void stops.push(stop),
    now: () => NOW,
  });
  try {
    await captureDaemonLogs(() => sweep.sweep());
  } finally {
    if (previousGap === undefined) delete Bun.env.COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS;
    else Bun.env.COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS = previousGap;
  }
  expect(stops).toEqual([
    {
      agentId: "codex",
      sessionId: "session-codex",
      idleMs: 31 * MINUTE,
      priorContextTokens: 200_000,
    },
  ]);
});

test("an Agent that turned busy while its session was read is left running", async () => {
  const { stops, state } = fixture({ a: {} });
  const provider = {
    async readSessionResumeFacts() {
      state.a = { ...state.a!, busyReason: "live_turn" };
      return { lastActivityAtMs: NOW - 70 * MINUTE, lastContextTokens: 300_000 };
    },
  } as unknown as CodeAgentProvider;
  const racing = new ColdIdleSweep({
    agentIds: () => ["a"],
    agent: () => state.a,
    provider: () => provider,
    stop: async (stop) => void stops.push(stop),
    now: () => NOW,
  });
  const { records } = await captureDaemonLogs(() => racing.sweep());
  expect(stops).toEqual([]);
  expect(
    records.find((r) => r.properties.event === "agent.runtime.cold_idle_sweep")?.properties,
  ).toMatchObject({ stops: 0, skipped_became_busy: 1 });
});

test("a failing stop is logged and the sweep goes on to the next Agent", async () => {
  const { state, facts } = fixture({ first: {}, second: {} });
  const stopped: string[] = [];
  const provider = {
    async readSessionResumeFacts() {
      return facts;
    },
  } as unknown as CodeAgentProvider;
  const sweep = new ColdIdleSweep({
    agentIds: () => Object.keys(state),
    agent: (agentId) => state[agentId],
    provider: () => provider,
    stop: async (stop) => {
      stopped.push(stop.agentId);
      if (stop.agentId === "first") throw new Error("would not exit");
    },
    now: () => NOW,
  });
  const { records } = await captureDaemonLogs(() => sweep.sweep());
  expect(stopped).toEqual(["first", "second"]);
  expect(records.some((r) => r.properties.event === "agent.runtime.cold_idle_stop_failed")).toBe(
    true,
  );
});

test("overlapping sweeps share one run", async () => {
  const { sweep, reads } = fixture({ a: {} });
  await Promise.all([sweep.sweep(), sweep.sweep()]);
  expect(reads).toEqual(["session-a"]);
});

test("the timer sweeps at the configured period until stopped, and stop is idempotent", async () => {
  Bun.env.COFORGE_WAKE_RECYCLE_SWEEP_MS = "5";
  const agentIds = Promise.withResolvers<void>();
  let calls = 0;
  const sweep = new ColdIdleSweep({
    agentIds: () => {
      if (++calls === 3) agentIds.resolve();
      return [];
    },
    agent: () => undefined,
    provider: () => ({}) as CodeAgentProvider,
    stop: async () => {},
  });
  sweep.start();
  sweep.start();
  try {
    await agentIds.promise;
  } finally {
    sweep.stop();
    sweep.stop();
  }
  // Once stopped the period no longer fires (several periods pass), but a sweep can still be asked.
  await sweep.sweep();
  const stoppedAt = calls;
  await Bun.sleep(30);
  expect(calls).toBe(stoppedAt);
});
