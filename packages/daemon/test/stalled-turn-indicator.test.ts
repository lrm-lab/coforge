import { expect, jest, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import {
  STALLED_TURN_MODEL_SILENCE_MS,
  STALLED_TURN_SILENCE_MS,
  StalledTurnTracker,
  endsStalledTurn,
  showsTurnWork,
  stalledTurnModelSilenceMs,
  stalledTurnNotice,
  stalledTurnSilenceMs,
  stalledTurnSilenceStartAtMs,
} from "#src/daemon-runtime/stalled-turn-indicator";
import { captureDaemonLogs } from "./log-capture";

/** The tracker's own lines, by their event name. */
function clockLines(records: readonly LogRecord[], event: string) {
  return records
    .filter((record) => record.properties.event === event)
    .map((record) => record.properties);
}

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

test("work under way is never read as the turn's end, however stale the session is", () => {
  const toolStart = {
    type: "tool-start",
    id: "exec-1",
    name: "bash",
    input: { command: "sleep 1500" },
  } as const;
  // Codex emits the command's item before it accepts the turn, so `hasLiveTurn` is still false at
  // that moment: that lag is not the turn's end (task #41).
  expect(showsTurnWork(toolStart)).toBe(true);
  expect(endsStalledTurn(toolStart, false)).toBe(false);
  expect(endsStalledTurn({ type: "thinking-delta", text: "" }, false)).toBe(false);
  expect(endsStalledTurn({ type: "text-delta", text: "hi" }, false)).toBe(false);
  expect(endsStalledTurn({ type: "tool-output", id: "exec-1", text: "…" }, false)).toBe(false);
  expect(endsStalledTurn({ type: "progress" }, false)).toBe(false);
  // Model output and tool activity reach the observation as these coalesced frames, and a frame
  // that shows the Agent working is the turn's own evidence too.
  expect(
    endsStalledTurn(
      {
        type: "activity",
        activity: {
          detailKind: "running_command",
          level: "info",
          detail: "",
          entries: [],
        } as never,
      },
      false,
    ),
  ).toBe(false);
  // Only an explicit ending does: a finished turn, or a session that reports it idle while the
  // event itself carries no work.
  expect(endsStalledTurn({ type: "completed", status: "completed" }, true)).toBe(true);
  expect(endsStalledTurn({ type: "tool-end", id: "exec-1", isError: false }, false)).toBe(true);
  // The turn's own bookkeeping is not an ending either: Codex sends these mid-turn with
  // `hasLiveTurn` still false (task #41, s144).
  expect(endsStalledTurn({ type: "usage", snapshot: {} as never }, false)).toBe(false);
  expect(endsStalledTurn({ type: "context-usage", usedTokens: 1, windowTokens: 2 }, false)).toBe(
    false,
  );
  expect(
    endsStalledTurn({ type: "session", identity: { sessionId: "t", state: "unknown" } }, false),
  ).toBe(false);
  expect(endsStalledTurn({ type: "service-tier", state: "on" } as never, false)).toBe(false);
  expect(
    endsStalledTurn(
      {
        type: "activity",
        activity: { detailKind: "idle", level: "info", detail: "Idle" } as never,
      },
      true,
    ),
  ).toBe(true);
});

test("a turn's first clock says when counting began, against which window", async () => {
  const { records } = await captureDaemonLogs(async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      const tracker = new StalledTurnTracker(() => undefined, 600_000, Date.now, 1_200_000);
      tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 1_000, hasOpenToolCall: false });
      // A second event moves the clock: the line stays one per clock, the move is debug.
      jest.setSystemTime(61_000);
      tracker.observe("agent-a", { turnBusy: true, lastEventAtMs: 61_000, hasOpenToolCall: true });
      tracker.finish("agent-a", "test_over");
    } finally {
      jest.useRealTimers();
    }
  }, "debug");
  expect(clockLines(records, "agent_runtime:turn_stalled_armed")).toEqual([
    expect.objectContaining({
      agent_id: "agent-a",
      stalled_window: "model",
      threshold_ms: 1_200_000,
      silence_started_at: 1_000,
      fires_in_ms: 1_200_000,
    }),
  ]);
  expect(clockLines(records, "agent_runtime:turn_stalled_rearmed")).toEqual([
    expect.objectContaining({
      stalled_window: "tool",
      threshold_ms: 600_000,
      silence_started_at: 61_000,
      previous_started_at: 1_000,
    }),
  ]);
  expect(clockLines(records, "agent_runtime:turn_stalled_finished")).toEqual([
    expect.objectContaining({ agent_id: "agent-a", fired: false, reason: "test_over" }),
  ]);
});

test("a tracker with both windows switched off says so instead of arming", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const tracker = new StalledTurnTracker(() => undefined, 0, Date.now, 0);
    tracker.start("agent-a", { turnBusy: true, lastEventAtMs: 0, hasOpenToolCall: true });
  });
  expect(clockLines(records, "agent_runtime:turn_stalled_armed")).toEqual([]);
  expect(clockLines(records, "agent_runtime:turn_stalled_disabled")).toEqual([
    expect.objectContaining({ agent_id: "agent-a", stalled_window: "tool", threshold_ms: 0 }),
  ]);
});

test("a stall whose Activity fails to publish still says so in the log", async () => {
  const launch = {
    launchId: "launch-a",
    progress: { lastEventAtMs: 1_000 },
  };
  const { result, records } = await captureDaemonLogs(async () => {
    const notice = stalledTurnNotice(launch, {
      isCurrent: () => true,
      publish: () => {
        throw new Error("transport gone");
      },
    });
    notice("agent-a", { silentForMs: 600_000, thresholdMs: 600_000, window: "tool" });
  });
  expect(result).toBeUndefined();
  expect(clockLines(records, "agent_runtime:turn_stalled")).toEqual([
    expect.objectContaining({
      agent_id: "agent-a",
      launch_id: "launch-a",
      stalled_window: "tool",
      threshold_ms: 600_000,
    }),
  ]);
  expect(clockLines(records, "agent_runtime:turn_stalled_publish_failed")).toEqual([
    expect.objectContaining({ agent_id: "agent-a", error: "transport gone" }),
  ]);
});
