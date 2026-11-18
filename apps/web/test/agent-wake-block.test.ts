import { expect, test } from "bun:test";
import {
  agentWakeBlock,
  agentWakeBlockReason,
  type AgentWakeBlockRow,
} from "#src/server/agents/agent-wake-block.server";

const at = new Date("2026-11-18T10:40:00.000Z");

function row(overrides: Partial<AgentWakeBlockRow> = {}): AgentWakeBlockRow {
  return { wakeBlockedReason: "stopped", wakeBlockedCount: 3, wakeBlockedAt: at, ...overrides };
}

test("only the three reasons a delivery can wait on are read back", () => {
  expect(agentWakeBlockReason("stopped")).toBe("stopped");
  expect(agentWakeBlockReason("start_failed")).toBe("start_failed");
  expect(agentWakeBlockReason("operation_in_flight")).toBe("operation_in_flight");
  expect(agentWakeBlockReason("woken")).toBeNull();
  expect(agentWakeBlockReason(null)).toBeNull();
  expect(agentWakeBlockReason(undefined)).toBeNull();
});

test("a stopped Agent's waiting messages stay on its profile until it is started", () => {
  expect(agentWakeBlock(row(), { stopped: true, controlPhase: undefined })).toEqual({
    reason: "stopped",
    messageCount: 3,
    at,
  });
  expect(agentWakeBlock(row(), { stopped: false, controlPhase: undefined })).toBeNull();
});

test("a stop made after the waiting messages were counted leaves no note", () => {
  const later = new Date(at.getTime() + 60_000);
  expect(
    agentWakeBlock(row(), { stopped: true, stoppedAt: later, now: later.getTime() }),
  ).toBeNull();
  expect(
    agentWakeBlock(row(), {
      stopped: true,
      stoppedAt: new Date(at.getTime() - 60_000),
      now: later.getTime(),
    }),
  ).not.toBeNull();
});

test("a transient block gives up after a day, so a later failure starts from zero", () => {
  const dayLater = at.getTime() + 24 * 60 * 60 * 1_000 + 1;
  const failed = row({ wakeBlockedReason: "start_failed", wakeBlockedCount: 1 });
  expect(
    agentWakeBlock(failed, { stopped: false, controlPhase: "failed", now: dayLater }),
  ).toBeNull();
  const inFlight = row({ wakeBlockedReason: "operation_in_flight", wakeBlockedCount: 1 });
  expect(
    agentWakeBlock(inFlight, { stopped: false, controlPhase: "starting", now: dayLater }),
  ).toBeNull();
});

test("a failed Start's waiting messages go once the control record moves on", () => {
  const failed = row({ wakeBlockedReason: "start_failed", wakeBlockedCount: 1 });
  expect(agentWakeBlock(failed, { stopped: false, controlPhase: "failed" })).not.toBeNull();
  expect(agentWakeBlock(failed, { stopped: false, controlPhase: "starting" })).toBeNull();
  expect(agentWakeBlock(failed, { stopped: false, controlPhase: "completed" })).toBeNull();
});

test("messages waiting on a Start in flight are shown while that Start has not settled", () => {
  const inFlight = row({ wakeBlockedReason: "operation_in_flight", wakeBlockedCount: 12 });
  for (const phase of ["starting", "stopping", "clearing", "workspace-reset"])
    expect(agentWakeBlock(inFlight, { stopped: false, controlPhase: phase })).not.toBeNull();
  for (const phase of ["completed", "failed"])
    expect(agentWakeBlock(inFlight, { stopped: false, controlPhase: phase })).toBeNull();
  expect(agentWakeBlock(inFlight, { stopped: false, controlPhase: undefined })).toBeNull();
});

test("an Agent with no recorded rejection, or a stale one, shows nothing", () => {
  expect(
    agentWakeBlock(row({ wakeBlockedReason: null }), { stopped: true, controlPhase: "failed" }),
  ).toBeNull();
  expect(
    agentWakeBlock(row({ wakeBlockedAt: null }), { stopped: true, controlPhase: "failed" }),
  ).toBeNull();
  expect(
    agentWakeBlock(row({ wakeBlockedCount: 0 }), { stopped: true, controlPhase: "failed" }),
  ).toBeNull();
  expect(
    agentWakeBlock(row({ wakeBlockedReason: "deleted" }), {
      stopped: true,
      controlPhase: "failed",
    }),
  ).toBeNull();
});
