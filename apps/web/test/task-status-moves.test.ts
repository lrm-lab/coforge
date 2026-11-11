import { expect, test } from "bun:test";

import { ordinaryTaskStatusMove, taskStatusMoveAllowed } from "@lrm/coforge-sdk/internal";

/** The whole table, so a change to it is a change here on purpose. */
const TABLE: Record<string, string[]> = {
  backlog: ["todo", "in_progress", "closed"],
  todo: ["backlog", "in_progress", "closed"],
  in_progress: ["backlog", "todo", "in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo"],
};

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "closed"] as const;

test("an ordinary member moves a Task forward, back for rework, and reopens a finished one", () => {
  for (const from of STATUSES)
    for (const to of STATUSES) {
      const allowed = to === from || TABLE[from]!.includes(to);
      expect(ordinaryTaskStatusMove(from, to)).toBe(allowed);
    }
});

test("a Task started by mistake goes back to Todo", () => {
  expect(ordinaryTaskStatusMove("in_progress", "todo")).toBe(true);
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

test("work is parked in Backlog and deferred back to it", () => {
  expect(ordinaryTaskStatusMove("backlog", "todo")).toBe(true);
  expect(ordinaryTaskStatusMove("backlog", "in_progress")).toBe(true);
  expect(ordinaryTaskStatusMove("backlog", "closed")).toBe(true);
  expect(ordinaryTaskStatusMove("todo", "backlog")).toBe(true);
  expect(ordinaryTaskStatusMove("in_progress", "backlog")).toBe(true);
  // Work that is being reviewed or done is not deferred; a closed Task reopens to Todo only.
  expect(ordinaryTaskStatusMove("in_review", "backlog")).toBe(false);
  expect(ordinaryTaskStatusMove("done", "backlog")).toBe(false);
  expect(ordinaryTaskStatusMove("closed", "backlog")).toBe(false);
  expect(ordinaryTaskStatusMove("backlog", "in_review")).toBe(false);
  expect(ordinaryTaskStatusMove("backlog", "done")).toBe(false);
});

test("the same status is not a move", () => {
  for (const status of STATUSES) expect(ordinaryTaskStatusMove(status, status)).toBe(true);
});

test("a Workspace owner or admin sets any status; everyone else follows the table", () => {
  for (const from of STATUSES)
    for (const to of STATUSES) {
      expect(taskStatusMoveAllowed(from, to, { manager: true })).toBe(true);
      expect(taskStatusMoveAllowed(from, to, { manager: false })).toBe(
        ordinaryTaskStatusMove(from, to),
      );
    }
});
