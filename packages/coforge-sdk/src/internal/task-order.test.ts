import { expect, test } from "bun:test";
import { compareTaskOrder, TASK_DUE_SOON_MS, taskDueState, type TaskPriority } from "./task-order";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("taskDueState reads overdue once the instant has passed", () => {
  expect(taskDueState(at(-1), NOW)).toBe("overdue");
  expect(taskDueState(at(-86_400_000), NOW)).toBe("overdue");
});

test("taskDueState reads due_soon up to and including a day out", () => {
  expect(taskDueState(at(0), NOW)).toBe("due_soon");
  expect(taskDueState(at(TASK_DUE_SOON_MS), NOW)).toBe("due_soon");
  expect(taskDueState(at(TASK_DUE_SOON_MS - 1), NOW)).toBe("due_soon");
});

test("taskDueState reads further dates and missing ones as null", () => {
  expect(taskDueState(at(TASK_DUE_SOON_MS + 1), NOW)).toBeNull();
  expect(taskDueState(null, NOW)).toBeNull();
  expect(taskDueState(undefined, NOW)).toBeNull();
  expect(taskDueState("", NOW)).toBeNull();
  expect(taskDueState("not a date", NOW)).toBeNull();
});

test("taskDueState takes a Date as well as an ISO string", () => {
  expect(taskDueState(new Date(NOW - 1), NOW)).toBe("overdue");
  expect(taskDueState(new Date(NOW + TASK_DUE_SOON_MS), NOW)).toBe("due_soon");
});

const task = (
  id: string,
  priority: TaskPriority | undefined,
  dueAt: string | null | undefined,
  createdAt: string,
) => ({ id, priority, dueAt, createdAt });

test("compareTaskOrder sorts priority first, whatever the due dates", () => {
  const low = task("a", "low", at(-1), at(-10_000));
  const urgent = task("b", "urgent", null, at(0));
  expect(compareTaskOrder(low, urgent)).toBeGreaterThan(0);
  expect(compareTaskOrder(urgent, low)).toBeLessThan(0);
});

test("compareTaskOrder puts the earliest due first inside one priority", () => {
  const later = task("a", "high", at(50_000), at(-10_000));
  const sooner = task("b", "high", at(10_000), at(0));
  expect(compareTaskOrder(later, sooner)).toBeGreaterThan(0);
  expect(compareTaskOrder(sooner, later)).toBeLessThan(0);
});

test("compareTaskOrder puts an undated task behind every dated one of its level", () => {
  const undated = task("a", "high", null, at(-10_000));
  const far = task("b", "high", at(365 * 86_400_000), at(0));
  expect(compareTaskOrder(undated, far)).toBeGreaterThan(0);
  expect(compareTaskOrder(far, undated)).toBeLessThan(0);
  // An overdue due still sorts before an undated one.
  const overdue = task("c", "high", at(-1), at(0));
  expect(compareTaskOrder(overdue, undated)).toBeLessThan(0);
});

test("compareTaskOrder breaks ties by oldest creation, then id", () => {
  const older = task("b", "medium", null, at(-10_000));
  const newer = task("a", "medium", null, at(0));
  expect(compareTaskOrder(newer, older)).toBeGreaterThan(0);
  const sameTimeA = task("a", "medium", null, at(0));
  const sameTimeB = task("b", "medium", null, at(0));
  expect(compareTaskOrder(sameTimeA, sameTimeB)).toBeLessThan(0);
  expect(compareTaskOrder(sameTimeB, sameTimeA)).toBeGreaterThan(0);
});

test("compareTaskOrder accepts Date instants as well as strings", () => {
  const left = {
    id: "a",
    priority: "high" as const,
    dueAt: new Date(NOW + 1_000),
    createdAt: new Date(NOW),
  };
  const right = {
    id: "b",
    priority: "high" as const,
    dueAt: new Date(NOW + 2_000),
    createdAt: new Date(NOW),
  };
  expect(compareTaskOrder(left, right)).toBeLessThan(0);
});
