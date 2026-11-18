import { expect, test } from "bun:test";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  startupDeadlineMs,
  type AgentControlResult,
} from "@lrm/coforge-sdk/internal";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlState,
} from "#src/server/agents/agent-control.server";
import { AgentControlOperations } from "#src/server/agents/agent-control-operations.server";
import { AgentControlReceiver } from "#src/server/agents/agent-control-receiver.server";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import {
  AgentControlStartupTimeout,
  STARTUP_DEADLINE_ERROR_CODE,
  STARTUP_STOP_CONFIRM_MS,
} from "#src/server/agents/agent-control-startup-timeout.server";
import {
  isEligibleForTransientRetry,
  TRANSIENT_FAILURE_MAX_WINDOW_MS,
} from "#src/server/agents/agent-control-types.server";
import { createAgentControlResultMethod } from "#src/server/centrifugo/agent-control-receiver.server";
import { pendingOpStore, pendingRuntimeConfig } from "./helpers/agent-control-store";

const START = 1_800_000_000_000;
const WINDOW = startupDeadlineMs("pi");

const startingState: AgentControlState = {
  version: 1,
  protocolMajor: 1,
  requestId: "r1",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  epoch: 3,
  action: "start",
  phase: "starting",
  configRevision: agentControlRevision(pendingRuntimeConfig),
  launchId: "launch-1",
  controlSequence: 0,
  sessionSequence: 0,
  startedAtMs: START,
  deadlineAtMs: START + WINDOW,
};

const agentWith = (state: AgentControlState): AgentControlAgent => ({
  id: "a",
  ownerId: "owner",
  visibility: "public",
  workspaceId: "w",
  computerId: "c",
  runtimeConfig: pendingRuntimeConfig,
  state,
});

function fixture(state: AgentControlState = startingState, online = true) {
  const store = pendingOpStore(agentWith(state));
  const connection = { online };
  const clock = { now: START };
  const stops: Uint8Array[] = [];
  const events: unknown[] = [];
  const reasons: string[] = [];
  const signal = new LocalAgentControlSignal();
  const notified: string[] = [];
  const notify = signal.notify.bind(signal);
  signal.notify = async (key: string) => {
    notified.push(key);
    return notify(key);
  };
  const timeout = new AgentControlStartupTimeout({
    store: store.store,
    signal,
    events: { publish: (_agent: unknown, event: unknown) => void events.push(event) } as never,
    stopReasons: async (_agent, reason) => void reasons.push(reason),
    runtimeLock: { run: async (_id, work) => work() },
    sendStop: async (next) => {
      const { encodeAgentStopIntent } = await import("@lrm/coforge-sdk/internal");
      stops.push(encodeAgentStopIntent({ ...next, controlEpoch: next.epoch }));
    },
    computerOnline: async () => connection.online,
    clock: () => clock.now,
  });
  return { ...store, clock, connection, stops, events, reasons, notified, timeout, signal };
}

async function captureWarnings<T>(work: () => Promise<T>) {
  const lines: Record<string, unknown>[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(JSON.parse(args[0] as string));
  try {
    return { value: await work(), lines };
  } finally {
    console.warn = original;
  }
}

test("a launch inside its window is left alone", async () => {
  const f = fixture();
  f.clock.now = START + WINDOW - 1;
  expect(await f.timeout.settle("a")).toBe("skipped");
  expect(f.current().state).toEqual(startingState);
  expect(f.stops).toHaveLength(0);
});

test("an expired launch on an online Computer bumps the epoch, keeps the request and sends a fenced Stop", async () => {
  const f = fixture();
  f.clock.now = START + WINDOW;
  expect(await f.timeout.settle("a")).toBe("stop_sent");
  expect(f.current().state).toMatchObject({
    phase: "starting",
    requestId: "r1",
    epoch: 4,
    stopSentAtMs: START + WINDOW,
  });
  const stop = decodeAgentStopIntent(f.stops[0]!);
  expect(stop).toMatchObject({ requestId: "r1", controlEpoch: 4, agentId: "a" });
});

test("the Stop is given sixty seconds before the launch is settled as failed", async () => {
  const f = fixture();
  f.clock.now = START + WINDOW;
  await f.timeout.settle("a");
  f.clock.now += STARTUP_STOP_CONFIRM_MS - 1;
  expect(await f.timeout.settle("a")).toBe("waiting");
  expect(f.current().state?.phase).toBe("starting");
  f.clock.now += 1;
  const { value, lines } = await captureWarnings(() => f.timeout.settle("a"));
  expect(value).toBe("failed");
  expect(f.current().state).toMatchObject({
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
    failedAtMs: f.clock.now,
    failedStreak: 1,
  });
  expect(lines).toEqual([
    expect.objectContaining({
      event: "agent_control:startup_timeout",
      provider: "pi",
      stop_outcome: "unconfirmed",
      elapsed_ms: WINDOW + STARTUP_STOP_CONFIRM_MS,
    }),
  ]);
});

test("an offline Computer only pushes the deadline out by another window, without a Stop", async () => {
  const f = fixture(startingState, false);
  f.clock.now = START + WINDOW;
  expect(await f.timeout.settle("a")).toBe("waiting");
  expect(f.stops).toHaveLength(0);
  expect(f.events).toHaveLength(0);
  expect(f.reasons).toHaveLength(0);
  expect(f.current().state).toMatchObject({
    phase: "starting",
    startedAtMs: START,
    deadlineAtMs: START + 2 * WINDOW,
    deadlineExtendedOfflineAtMs: START + WINDOW,
  });
});

test("a Computer that comes back a second before the pushed-out deadline gets a full window, not a Stop", async () => {
  const f = fixture(startingState, false);
  f.clock.now = START + WINDOW;
  expect(await f.timeout.settle("a")).toBe("waiting");
  f.connection.online = true;
  f.clock.now = START + 2 * WINDOW - 1;
  expect(await f.timeout.settle("a")).toBe("skipped");
  f.clock.now = START + 2 * WINDOW;
  expect(await f.timeout.settle("a")).toBe("waiting");
  expect(f.stops).toHaveLength(0);
  expect(f.current().state).toMatchObject({
    phase: "starting",
    deadlineAtMs: START + 3 * WINDOW,
  });
  expect(f.current().state?.deadlineExtendedOfflineAtMs).toBeUndefined();
  f.clock.now = START + 3 * WINDOW;
  expect(await f.timeout.settle("a")).toBe("stop_sent");
  expect(f.stops).toHaveLength(1);
});

test("a Computer that comes back inside the pushed-out window still settles from the Daemon's started", async () => {
  const f = fixture(startingState, false);
  f.clock.now = START + WINDOW;
  expect(await f.timeout.settle("a")).toBe("waiting");
  const state = f.current().state!;
  const receiver = new AgentControlReceiver(
    f.store,
    f.signal,
    {} as never,
    undefined,
    async (_agent, reason) => void f.reasons.push(reason),
    { publish: (_agent: unknown, event: unknown) => void f.events.push(event) } as never,
  );
  f.clock.now = START + 2 * WINDOW - 1;
  await receiver.result(
    claim,
    resultFor(state, { phase: "started", launchId: "launch-1", sequence: 1 }),
  );
  expect(f.current().state).toMatchObject({ phase: "completed" });
});

test("a Computer still offline a day after the launch began settles it as failed", async () => {
  const f = fixture(startingState, false);
  f.clock.now = START + TRANSIENT_FAILURE_MAX_WINDOW_MS + 1;
  const { value, lines } = await captureWarnings(() => f.timeout.settle("a"));
  expect(value).toBe("failed");
  expect(f.stops).toHaveLength(0);
  expect(f.current().state).toMatchObject({
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
  });
  expect(lines[0]).toMatchObject({ stop_outcome: "offline" });
  expect(f.events).toEqual([
    expect.objectContaining({
      requestId: "r1",
      phase: "failed",
      errorCode: STARTUP_DEADLINE_ERROR_CODE,
    }),
  ]);
  expect(f.reasons).toEqual([STARTUP_DEADLINE_ERROR_CODE]);
  expect(f.notified).toEqual(["a"]);
});

test("the same launch is settled once when two sweeps race", async () => {
  const f = fixture({
    ...startingState,
    epoch: 4,
    controlSequence: 0,
    stopSentAtMs: START + WINDOW,
  });
  f.clock.now = START + WINDOW + STARTUP_STOP_CONFIRM_MS;
  const results = await Promise.all([f.timeout.settle("a"), f.timeout.settle("a")]);
  expect(results.sort()).toEqual(["failed", "lost"]);
  expect(f.events).toHaveLength(1);
  expect(f.current().state?.failedStreak).toBe(1);
});

test("a launch settled by something else meanwhile is never touched", async () => {
  const f = fixture({ ...startingState, phase: "completed" });
  f.clock.now = START + WINDOW * 2;
  expect(await f.timeout.settle("a")).toBe("skipped");
  expect(f.events).toHaveLength(0);
});

test("a launch written before the deadline fields existed gets a window instead of an instant failure", async () => {
  const { startedAtMs: _s, deadlineAtMs: _d, ...legacy } = startingState;
  const f = fixture(legacy);
  f.clock.now = START + 7_000;
  expect(await f.timeout.settle("a")).toBe("armed");
  expect(f.current().state).toMatchObject({
    phase: "starting",
    startedAtMs: f.clock.now,
    deadlineAtMs: f.clock.now + WINDOW,
  });
});

function resultFor(
  state: AgentControlState,
  patch: Partial<AgentControlResult> & { phase: AgentControlResult["phase"] },
): AgentControlResult {
  return {
    protocolMajor: 1,
    requestId: state.requestId,
    workspaceId: state.workspaceId,
    computerId: state.computerId,
    agentId: state.agentId,
    provider: "pi",
    epoch: state.epoch,
    sequence: 1,
    ...patch,
  } as AgentControlResult;
}

const claim = { workspaceId: "w", computerId: "c" };

async function afterStopSent(state: AgentControlState = startingState) {
  const f = fixture(state);
  f.clock.now = START + WINDOW;
  await f.timeout.settle("a");
  const receiver = new AgentControlReceiver(
    f.store,
    f.signal,
    {} as never,
    undefined,
    async (_agent, reason) => void f.reasons.push(reason),
    { publish: (_agent: unknown, event: unknown) => void f.events.push(event) } as never,
  );
  return { ...f, receiver };
}

test("the Daemon's stopped receipt for the fenced Stop settles the launch as failed, confirmed", async () => {
  const f = await afterStopSent();
  const state = f.current().state!;
  const { lines } = await captureWarnings(() =>
    f.receiver.result(claim, resultFor(state, { phase: "stopped", sequence: 1 })),
  );
  expect(f.current().state).toMatchObject({
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
    controlSequence: 1,
    failedStreak: 1,
  });
  expect(lines[0]).toMatchObject({ stop_outcome: "confirmed" });
  expect(f.events.at(-1)).toMatchObject({
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
  });
});

test("the fenced Stop restarts the result sequence, so the receipt for its epoch is accepted", async () => {
  const f = await afterStopSent({ ...startingState, controlSequence: 1 });
  expect(f.current().state).toMatchObject({ phase: "starting", epoch: 4, controlSequence: 0 });
  const state = f.current().state!;
  await captureWarnings(() =>
    f.receiver.result(claim, resultFor(state, { phase: "stopped", sequence: 1 })),
  );
  expect(f.current().state).toMatchObject({
    phase: "failed",
    controlSequence: 1,
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
  });
});

test("a started result under the epoch the Stop replaced is refused and the launch stays pending", async () => {
  const f = await afterStopSent();
  const state = f.current().state!;
  const control = {
    result: f.receiver.result.bind(f.receiver),
  };
  const method = createAgentControlResultMethod(control);
  const { encodeAgentControlResult } = await import("@lrm/coforge-sdk/internal");
  const late = encodeAgentControlResult(
    resultFor(state, { phase: "started", epoch: 3, launchId: "launch-1", sequence: 1 }),
  );
  const { value, lines } = await captureWarnings(() =>
    Promise.resolve(
      method(late, { principal: { userId: "daemon", workspaceId: "w", computerId: "c" } }),
    ),
  );
  expect(value).toEqual({ code: 403, message: "Agent control result is not authorized" });
  expect(lines[0]).toMatchObject({
    event: "agent_control:result_rejected",
    phase: "started",
    epoch: 3,
    reason: "Stale Agent scope",
  });
  expect(f.current().state).toMatchObject({ phase: "starting", epoch: 4 });
});

test("once settled, a late started or stopped result for the launch is refused", async () => {
  const f = await afterStopSent();
  f.clock.now += STARTUP_STOP_CONFIRM_MS;
  await captureWarnings(() => f.timeout.settle("a"));
  const state = f.current().state!;
  expect(state.phase).toBe("failed");
  await expect(
    f.receiver.result(claim, resultFor(state, { phase: "started", launchId: "launch-1" })),
  ).rejects.toThrow();
  await expect(f.receiver.result(claim, resultFor(state, { phase: "stopped" }))).rejects.toThrow();
  expect(f.current().state?.phase).toBe("failed");
});

function controlOver(
  store: ReturnType<typeof pendingOpStore>["store"],
  sent: Uint8Array[],
  now: () => number,
) {
  return new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0, now },
  );
}

const readyIntent = {
  protocolMajor: 1,
  requestId: "ready-recovery",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi" as const,
  model: "",
  reasoning: "",
};

test("a Computer reconnecting while the Stop is outstanding is sent the Stop again, never a Start", async () => {
  const f = await afterStopSent();
  const sent: Uint8Array[] = [];
  await controlOver(f.store, sent, () => f.clock.now).recover(readyIntent, "owner");
  expect(sent).toHaveLength(1);
  expect(() => decodeAgentStartIntent(sent[0]!)).toThrow();
  expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "r1", controlEpoch: 4 });
  expect(f.current().state).toMatchObject({ phase: "starting", epoch: 4, requestId: "r1" });
});

test("a Computer that dropped before the Stop arrived is not relaunched when it comes back after the failure", async () => {
  const f = await afterStopSent();
  f.clock.now += STARTUP_STOP_CONFIRM_MS;
  await captureWarnings(() => f.timeout.settle("a"));
  expect(f.current().state?.phase).toBe("failed");
  const sent: Uint8Array[] = [];
  await controlOver(f.store, sent, () => f.clock.now).recover(readyIntent, "owner");
  expect(sent).toHaveLength(0);
  expect(f.current().state?.phase).toBe("failed");
});

test("startup_deadline_exceeded retries inside the transient window and stops at the streak cap", () => {
  const failed = (failedStreak: number): AgentControlAgent =>
    agentWith({
      ...startingState,
      phase: "failed",
      errorCode: STARTUP_DEADLINE_ERROR_CODE,
      failedAtMs: START,
      failedStreak,
    });
  expect(isEligibleForTransientRetry(failed(1), START + 15 * 60_000)).toBe(true);
  expect(isEligibleForTransientRetry(failed(2), START + 15 * 60_000)).toBe(false);
  expect(isEligibleForTransientRetry(failed(1), START + 5 * 60_000)).toBe(false);
});

test("a person's Start after the timeout supersedes the failed launch with a fresh window", async () => {
  const failed: AgentControlState = {
    ...startingState,
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
    failedAtMs: START,
    failedStreak: 2,
  };
  const { store, current } = pendingOpStore(agentWith(failed));
  const operations = new AgentControlOperations(store, {} as never, undefined, () => START + 9_000);
  await operations.begin(agentWith(failed), "start", "manual-start");
  expect(current().state).toMatchObject({
    requestId: "manual-start",
    epoch: 4,
    phase: "starting",
    startedAtMs: START + 9_000,
    deadlineAtMs: START + 9_000 + WINDOW,
  });
  expect(current().state?.errorCode).toBeUndefined();
  expect(current().state?.failedStreak).toBeUndefined();
});
