import { expect, jest, test } from "bun:test";
import {
  logStalledRecovery,
  logStalledRuntimeRestart,
} from "#src/daemon-runtime/agent-failure-logs";
import {
  STALLED_RECOVERY_SILENCE_MS,
  STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS,
  stalledRecoveryBasis,
  type StalledRecoveryFacts,
} from "#src/daemon-runtime/stalled-recovery";
import {
  STALLED_TURN_SILENCE_MS,
  StalledTurnTracker,
  stalledTurnNotice,
} from "#src/daemon-runtime/stalled-turn-indicator";
import { captureDaemonLogs } from "./log-capture";

// The line a stall repair writes has to carry the judgment it made — how long the provider had
// been silent, whether a tool was still open, which fuse applied — or the repair cannot be
// reviewed after the fact (task #698).

const START = new Date("2026-10-15T00:00:00.000Z");
const LAST_EVENT_AT = START.getTime() - STALLED_RECOVERY_SILENCE_MS;

/** A busy turn silent for exactly `silentForMs`, with nothing open and a resumable session. */
function facts(overrides: Partial<StalledRecoveryFacts> = {}): StalledRecoveryFacts {
  return {
    turnBusy: true,
    liveTurn: true,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: true,
    ...overrides,
  };
}

test("the judgment reports which fuse fired and the threshold it used", () => {
  const steering = stalledRecoveryBasis(facts(), { lastEventAtMs: LAST_EVENT_AT });
  expect(steering).toMatchObject({
    reason: "silent_turn",
    thresholdMs: STALLED_RECOVERY_SILENCE_MS,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    lastEventAtMs: LAST_EVENT_AT,
  });
  // A queue-only provider's silent turn is judged against the longer fuse.
  const queueOnly = stalledRecoveryBasis(
    facts({ silentForMs: STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS, steersBusyTurn: false }),
    { lastEventAtMs: LAST_EVENT_AT },
  );
  expect(queueOnly).toMatchObject({
    reason: "silent_turn",
    thresholdMs: STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS,
  });
  // The same silence is not enough for a queue-only provider.
  expect(
    stalledRecoveryBasis(
      facts({ silentForMs: STALLED_RECOVERY_SILENCE_MS, steersBusyTurn: false }),
      {
        lastEventAtMs: LAST_EVENT_AT,
      },
    ),
  ).toBeUndefined();
  expect(
    stalledRecoveryBasis(facts({ turnBusy: false, liveTurn: false, queuedForMs: 900_000 }), {
      lastEventAtMs: LAST_EVENT_AT,
    }),
  ).toMatchObject({
    reason: "queued_turn_never_started",
    thresholdMs: STALLED_RECOVERY_SILENCE_MS,
  });
  expect(
    stalledRecoveryBasis(facts({ turnBusy: false, liveTurn: true, noticeAcceptedForMs: 900_000 }), {
      lastEventAtMs: LAST_EVENT_AT,
    }),
  ).toMatchObject({ reason: "noticed_but_frozen" });
  // No turn in progress is Raft's committed-idle Agent: taking a notice and being idle is its own
  // choice, never a frozen turn (task #14 — this is what restarted grace while she sat idle).
  expect(
    stalledRecoveryBasis(
      facts({ turnBusy: false, liveTurn: false, noticeAcceptedForMs: 900_000 }),
      { lastEventAtMs: LAST_EVENT_AT },
    ),
  ).toBeUndefined();
  // Nothing is judged over a tool still running.
  expect(
    stalledRecoveryBasis(facts({ hasOpenToolCall: true }), { lastEventAtMs: LAST_EVENT_AT }),
  ).toBeUndefined();
});

test("a repair line carries the silence, the fuse, and that nothing was running", async () => {
  const basis = stalledRecoveryBasis(facts(), { lastEventAtMs: LAST_EVENT_AT });
  expect(basis).toBeDefined();
  const { records } = await captureDaemonLogs(async () => {
    logStalledRecovery("agent-a", basis!);
    logStalledRuntimeRestart("agent-a", basis!, true);
  });
  const judged = records.find((record) => record.properties.event === "turn_stalled");
  expect(judged?.properties).toMatchObject({
    agent_id: "agent-a",
    reason: "silent_turn",
    silent_for_ms: STALLED_RECOVERY_SILENCE_MS,
    threshold_ms: STALLED_RECOVERY_SILENCE_MS,
    last_event_at: LAST_EVENT_AT,
    steers_busy_turn: true,
  });
  const restarted = records.find(
    (record) => record.properties.event === "agent.runtime.stalled_recovery",
  );
  expect(restarted?.properties).toMatchObject({
    agent_id: "agent-a",
    reason: "silent_turn",
    threshold_ms: STALLED_RECOVERY_SILENCE_MS,
    last_event_at: LAST_EVENT_AT,
    unattended: true,
  });
});

test("the visible stalled notice carries its own threshold and open tool", async () => {
  const { records } = await captureDaemonLogs(async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(START);
      const launch = {
        launchId: "launch-1",
        progress: { lastEventAtMs: START.getTime() },
        toolCalls: {
          oldestOpenTool: () => ({ name: "bash", silentForMs: STALLED_TURN_SILENCE_MS }),
        },
      };
      const tracker = new StalledTurnTracker(
        stalledTurnNotice(launch, { isCurrent: () => true, publish: () => undefined }),
        STALLED_TURN_SILENCE_MS,
      );
      tracker.start("agent-a", {
        turnBusy: true,
        lastEventAtMs: START.getTime(),
        hasOpenToolCall: true,
      });
      jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS);
      tracker.finish("agent-a");
    } finally {
      jest.useRealTimers();
    }
  });
  const stalled = records.find(
    (record) => record.properties.event === "agent_runtime:turn_stalled",
  );
  expect(stalled?.properties).toMatchObject({
    agent_id: "agent-a",
    launch_id: "launch-1",
    silent_for_ms: STALLED_TURN_SILENCE_MS,
    threshold_ms: STALLED_TURN_SILENCE_MS,
    last_event_at: START.getTime(),
    open_tool: "bash",
    open_tool_for_ms: STALLED_TURN_SILENCE_MS,
  });
});
