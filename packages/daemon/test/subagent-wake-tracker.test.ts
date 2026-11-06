import { expect, test } from "bun:test";
import { SubagentWakeTracker } from "#src/agent-runtime/subagent-progress-activity";

test("a quiet terminal result earns exactly one wake, consumed once", () => {
  const wake = new SubagentWakeTracker();
  wake.noteTerminal("task-1", "completed");
  expect(wake.resultUnread).toBe(true);
  expect(wake.takeWake()).toBe(true);
  expect(wake.takeWake()).toBe(false);
  expect(wake.resultUnread).toBe(false);
});

test("a user-stopped task is forgotten and earns no wake", () => {
  const wake = new SubagentWakeTracker();
  wake.noteUserStop("task-1");
  expect(wake.noteTerminal("task-1", "stopped")).toBe(true);
  expect(wake.resultUnread).toBe(false);
  expect(wake.takeWake()).toBe(false);
});

test("a user-stopped task that finished anyway still carries an untold result", () => {
  const wake = new SubagentWakeTracker();
  wake.noteUserStop("task-1");
  expect(wake.noteTerminal("task-1", "completed")).toBe(false);
  expect(wake.resultUnread).toBe(true);
});
