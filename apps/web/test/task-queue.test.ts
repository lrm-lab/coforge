import { expect, test } from "bun:test";
import type { TaskPriority, TaskStatus } from "@lrm/coforge-sdk/internal";
import {
  compareQueueTasks,
  ownTaskQueue,
  queueActionable,
  type QueueTask,
} from "#src/server/tasks/task-queue.server";

const task = (id: string, fields: Partial<Omit<QueueTask, "id">> = {}): QueueTask => ({
  id,
  status: "todo",
  priority: "none",
  blocked: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...fields,
});

test("the queue numbers Todo and In Progress Tasks no blocker holds, in priority then age order", () => {
  const entries = [
    task("late-low", { priority: "low", createdAt: "2026-11-01T00:00:02.000Z" }),
    task("early-low", { priority: "low", createdAt: "2026-11-01T00:00:01.000Z" }),
    task("urgent", { status: "in_progress", priority: "urgent" }),
    task("high", { priority: "high" }),
    task("none", {}),
  ];
  const { queue, positions } = ownTaskQueue(entries);
  expect(queue.map((entry) => entry.task.id)).toEqual([
    "urgent",
    "high",
    "early-low",
    "late-low",
    "none",
  ]);
  expect(queue.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5]);
  expect(positions.get("late-low")).toBe(4);
});

test("a Task in review, blocked, or finished never enters the queue", () => {
  const { queue, positions } = ownTaskQueue([
    task("review", { status: "in_review", priority: "urgent" }),
    task("blocked-todo", { blocked: true, priority: "urgent" }),
    task("blocked-progress", { status: "in_progress", blocked: true }),
    task("done", { status: "done" }),
    task("closed", { status: "closed" }),
    task("open", {}),
  ]);
  expect(queue.map((entry) => entry.task.id)).toEqual(["open"]);
  expect(positions.get("review")).toBeUndefined();
  expect(positions.get("blocked-todo")).toBeUndefined();
});

test("positions stay contiguous when non-queue Tasks interleave the input", () => {
  const { queue } = ownTaskQueue([
    task("b", { createdAt: "2026-11-01T00:00:03.000Z" }),
    task("waiting", { status: "in_review" }),
    task("a", { createdAt: "2026-11-01T00:00:01.000Z" }),
    task("c", { createdAt: "2026-11-01T00:00:02.000Z" }),
  ]);
  expect(queue.map((entry) => [entry.task.id, entry.position])).toEqual([
    ["a", 1],
    ["c", 2],
    ["b", 3],
  ]);
});

test("the same createdAt falls back to id, and Date and ISO string createdAt order alike", () => {
  const same = "2026-11-01T00:00:00.000Z";
  const { queue } = ownTaskQueue([
    task("b-id", { createdAt: new Date(same) }),
    task("a-id", { createdAt: same }),
  ]);
  expect(queue.map((entry) => entry.task.id)).toEqual(["a-id", "b-id"]);
  expect(
    compareQueueTasks(task("x", { priority: "high" }), task("y", { priority: "urgent" })),
  ).toBeGreaterThan(0);
});

test("queueActionable reads only status and blocked", () => {
  const statuses: TaskStatus[] = ["todo", "in_progress", "in_review", "done", "closed"];
  for (const status of statuses)
    for (const blocked of [false, true])
      expect(queueActionable({ status, blocked })).toBe(
        (status === "todo" || status === "in_progress") && !blocked,
      );
  const priorities: (TaskPriority | undefined)[] = [
    "urgent",
    "high",
    "medium",
    "low",
    "none",
    undefined,
  ];
  for (const priority of priorities) expect(queueActionable(task("p", { priority }))).toBe(true);
});
