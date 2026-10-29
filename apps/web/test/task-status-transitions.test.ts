import { expect, test } from "bun:test";

import { ordinaryTaskStatusMove } from "#src/server/tasks/task-status-transitions.server";

/** The whole table, so a change to it is a change here on purpose. */
const TABLE: Record<string, string[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo"],
};

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;

test("an ordinary member moves a Task forward, back for rework, and reopens a finished one", () => {
  for (const from of STATUSES)
    for (const to of STATUSES) {
      const allowed = to === from || TABLE[from]!.includes(to);
      expect(ordinaryTaskStatusMove(from, to)).toBe(allowed);
    }
});

test("In Review goes back to In Progress for more work", () => {
  expect(ordinaryTaskStatusMove("in_review", "in_progress")).toBe(true);
});

test("work does not skip ahead, and a closed Task reopens only to Todo", () => {
  expect(ordinaryTaskStatusMove("todo", "in_review")).toBe(false);
  expect(ordinaryTaskStatusMove("todo", "done")).toBe(false);
  expect(ordinaryTaskStatusMove("in_progress", "done")).toBe(false);
  expect(ordinaryTaskStatusMove("closed", "in_progress")).toBe(false);
  expect(ordinaryTaskStatusMove("closed", "done")).toBe(false);
});

test("the same status is not a move", () => {
  for (const status of STATUSES) expect(ordinaryTaskStatusMove(status, status)).toBe(true);
});
