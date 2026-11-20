import { expect, test } from "bun:test";

import {
  TASK_READ_STATUSES,
  TASK_WRITE_STATUSES,
  ordinaryTaskStatusMove,
  taskStatusMoveAllowed,
  taskStatusNeedsOwner,
} from "@lrm/coforge-sdk/internal";

import { withoutAssignee } from "#src/server/tasks/task-change.server";

test("any status can move freely to any writable status, and never to retired in_review", () => {
  for (const from of TASK_READ_STATUSES)
    for (const to of TASK_WRITE_STATUSES) {
      expect(ordinaryTaskStatusMove(from, to)).toBe(true);
      expect(taskStatusMoveAllowed(from, to, { manager: false })).toBe(true);
      expect(taskStatusMoveAllowed(from, to, { manager: true })).toBe(true);
    }
  for (const from of TASK_READ_STATUSES) {
    expect(ordinaryTaskStatusMove(from, "in_review" as never)).toBe(false);
    expect(taskStatusMoveAllowed(from, "in_review" as never, { manager: false })).toBe(false);
    expect(taskStatusMoveAllowed(from, "in_review" as never, { manager: true })).toBe(false);
  }
});

test("status is decoupled from ownership", () => {
  for (const status of TASK_WRITE_STATUSES) expect(taskStatusNeedsOwner(status)).toBe(false);
  for (const status of ["backlog", "todo", "in_progress", "closed"] as const)
    expect(withoutAssignee({ status, number: 1 })).toEqual({
      ownerMemberId: null,
      claimedAt: null,
    });
  try {
    withoutAssignee({ status: "done", number: 1 });
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ code: "CONFLICT", hint: expect.stringContaining("done") });
  }
});
