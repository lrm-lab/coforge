import { expect, jest, test } from "bun:test";
import {
  STALLED_TURN_MODEL_SILENCE_MS,
  STALLED_TURN_SILENCE_MS,
  StalledTurnTracker,
  stalledTurnModelSilenceMs,
  stalledTurnSilenceMs,
  stalledTurnSilenceStartAtMs,
} from "#src/daemon-runtime/stalled-turn-indicator";

test("the silence window defaults, accepts launch zero, and rejects malformed values", () => {
  expect(stalledTurnSilenceMs(undefined, {})).toBe(STALLED_TURN_SILENCE_MS);
  expect(stalledTurnSilenceMs({ COFORGE_STALLED_TURN_SILENCE_MS: "0" }, {})).toBe(0);
  expect(stalledTurnSilenceMs({ COFORGE_STALLED_TURN_SILENCE_MS: "1200" }, {})).toBe(1200);
  expect(stalledTurnSilenceMs({ COFORGE_STALLED_TURN_SILENCE_MS: "-1" }, {})).toBe(
    STALLED_TURN_SILENCE_MS,
  );
  expect(stalledTurnSilenceMs({ COFORGE_STALLED_TURN_SILENCE_MS: "oops" }, {})).toBe(
    STALLED_TURN_SILENCE_MS,
  );
});

test("the model window resolves on its own variable, so one can be tuned without the other", () => {
  expect(stalledTurnModelSilenceMs(undefined, {})).toBe(STALLED_TURN_MODEL_SILENCE_MS);
  expect(stalledTurnModelSilenceMs({ COFORGE_STALLED_TURN_MODEL_SILENCE_MS: "0" }, {})).toBe(0);
  expect(stalledTurnModelSilenceMs({ COFORGE_STALLED_TURN_MODEL_SILENCE_MS: "1200" }, {})).toBe(
    1200,
  );
  // The tool window's variable does not move it: a launch that tuned one window keeps the other.
  expect(stalledTurnModelSilenceMs({ COFORGE_STALLED_TURN_SILENCE_MS: "5" }, {})).toBe(
    STALLED_TURN_MODEL_SILENCE_MS,
  );
});

test("silence starts at the newer of provider progress and the oldest open tool", () => {
  expect(
    stalledTurnSilenceStartAtMs({
      turnBusy: true,
      lastEventAtMs: 100,
      oldestToolStartedAtMs: 250,
      hasOpenToolCall: true,
    }),
  ).toBe(250);
  expect(
    stalledTurnSilenceStartAtMs({
      turnBusy: true,
      lastEventAtMs: 300,
      oldestToolStartedAtMs: 250,
      hasOpenToolCall: true,
    }),
  ).toBe(300);
});

test("a stalled tool emits once per silent segment", () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(0);
    const notices: Array<{
      agentId: string;
      silentForMs: number;
      thresholdMs: number;
      window: string;
    }> = [];
    const tracker = new StalledTurnTracker(
      (agentId, indicator) => notices.push({ agentId, ...indicator }),
      1_000,
    );
    tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 0, hasOpenToolCall: true });
    jest.advanceTimersByTime(999);
    expect(notices).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(notices).toEqual([
      { agentId: "agent-a", silentForMs: 1_000, thresholdMs: 1_000, window: "tool" },
    ]);
    tracker.observe("agent-a", { turnBusy: true, lastEventAtMs: 1_000, hasOpenToolCall: true });
    jest.advanceTimersByTime(5_000);
    expect(notices).toHaveLength(2);
    tracker.finish("agent-a");
  } finally {
    jest.useRealTimers();
  }
});

test("provider progress resets the silence clock, and idle turns cancel it", () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(0);
    const notices: string[] = [];
    const tracker = new StalledTurnTracker((agentId) => notices.push(agentId), 1_000);
    tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 0, hasOpenToolCall: true });
    jest.advanceTimersByTime(900);
    tracker.observe("agent-a", { turnBusy: true, lastEventAtMs: 900, hasOpenToolCall: true });
    jest.advanceTimersByTime(999);
    expect(notices).toEqual([]);
    tracker.observe("agent-a", { turnBusy: false, lastEventAtMs: 1_899, hasOpenToolCall: true });
    jest.advanceTimersByTime(10_000);
    expect(notices).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test("zero disables the stalled indicator", () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(0);
    const notices: string[] = [];
    const tracker = new StalledTurnTracker((agentId) => notices.push(agentId), 0);
    tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 0, hasOpenToolCall: true });
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS * 2);
    expect(notices).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test("model-only silence is reported on the longer window, so a person can stop the turn", () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(0);
    const notices: Array<{ silentForMs: number; thresholdMs: number; window: string }> = [];
    const tracker = new StalledTurnTracker(
      (_agentId, indicator) => notices.push({ ...indicator }),
      1_000,
      Date.now,
      20_000,
    );
    tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 0, hasOpenToolCall: false });
    // The tool window is not this turn's: nothing is reported at 1 s or at 19.999 s.
    jest.advanceTimersByTime(19_999);
    expect(notices).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(notices).toEqual([{ silentForMs: 20_000, thresholdMs: 20_000, window: "model" }]);
    // Provider progress starts the model's clock over.
    tracker.observe("agent-a", { turnBusy: true, lastEventAtMs: 20_000, hasOpenToolCall: false });
    jest.advanceTimersByTime(19_999);
    expect(notices).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(notices).toHaveLength(2);
    tracker.finish("agent-a");
  } finally {
    jest.useRealTimers();
  }
});

test("a model window of zero leaves only the tool window", () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(0);
    const notices: string[] = [];
    const tracker = new StalledTurnTracker((agentId) => notices.push(agentId), 1_000, Date.now, 0);
    tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 0, hasOpenToolCall: false });
    jest.advanceTimersByTime(STALLED_TURN_MODEL_SILENCE_MS * 2);
    expect(notices).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});
