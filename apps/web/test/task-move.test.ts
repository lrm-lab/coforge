import { describe, expect, test } from "bun:test";
import type { TaskStatus, TaskWriteStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { getTaskMoveCommand, taskStatusOptions } from "#src/features/tasks/task-move";

const task = (status: TaskStatus, owner: TaskView["owner"] = null): TaskView => ({
  id: "message-1",
  messageId: "message-1",
  conversationId: "conversation-1",
  number: 7,
  title: "Move me",
  status,
  revision: 4,
  blockedBy: [],
  blocked: false,
  parent: null,
  subtasks: null,
  owner,
  creator: {
    memberId: "member-creator",
    kind: "user",
    id: "user-creator",
    name: "Creator",
    handle: "creator",
  },
  createdAt: "2026-09-24T08:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z",
});

const owner = (memberId: string): NonNullable<TaskView["owner"]> => ({
  memberId,
  kind: "user",
  id: `user-${memberId}`,
  name: memberId,
  handle: memberId,
});

const update = (status: TaskWriteStatus) => ({
  operation: "update" as const,
  number: 7,
  status,
  expectedRevision: 4,
});

describe("getTaskMoveCommand", () => {
  test("does nothing without membership or when status is unchanged", () => {
    expect(getTaskMoveCommand(task("todo"), null, "in_progress")).toBeUndefined();
    expect(
      getTaskMoveCommand(task("in_progress", owner("me")), "me", "in_progress"),
    ).toBeUndefined();
    expect(
      getTaskMoveCommand(task("todo", owner("me")), "me", "in_review" as never),
    ).toBeUndefined();
  });

  test("claims an available or self-reserved backlog or todo moved to in progress", () => {
    expect(getTaskMoveCommand(task("todo"), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("backlog"), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo", owner("me")), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo"), "me", "done")).toEqual(update("done"));
  });

  test("any member moves a Task freely between writable statuses, including unowned tasks", () => {
    const mine = owner("me");
    const other = owner("other");
    for (const current of [null, mine, other]) {
      for (const from of ["backlog", "todo", "in_progress", "in_review", "done", "closed"] as const)
        for (const to of ["backlog", "todo", "in_progress", "done", "closed"] as const) {
          if (from === to) continue;
          const result = getTaskMoveCommand(task(from, current), "me", to);
          const isClaim =
            (from === "backlog" || from === "todo") &&
            to === "in_progress" &&
            (!current || current.memberId === "me");
          expect(result).toEqual(isClaim ? { operation: "claim", number: 7 } : update(to));
        }
    }
  });

  test("a Task made to create a resource is not offered Done until its receipt is in", () => {
    const awaiting = { ...task("in_progress", owner("me")), requiresResourceReceipt: true };
    expect(getTaskMoveCommand(awaiting, "me", "done")).toBeUndefined();
    expect(getTaskMoveCommand(awaiting, "me", "done", { canSetAnyStatus: true })).toBeUndefined();
    const received: TaskView = {
      ...awaiting,
      resourceReceipt: {
        object: "staging database",
        purpose: "load test",
        teardownOwner: "@me",
        securityPrivacy: "no personal data",
        expiry: "2026-12-01",
        runbook: "docs/runbook.md",
        tracking: "#12",
      },
    };
    expect(getTaskMoveCommand(received, "me", "done")).toEqual(update("done"));
  });
});

describe("taskStatusOptions", () => {
  test("offers the current status first, then every other writable status", () => {
    const mine = owner("me");
    expect(taskStatusOptions(task("todo", mine), "me")).toEqual([
      "todo",
      "backlog",
      "in_progress",
      "done",
      "closed",
    ]);
    expect(taskStatusOptions(task("backlog"), "me")).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "done",
      "closed",
    ]);
    expect(taskStatusOptions(task("in_review", mine), "me")).toEqual([
      "in_review",
      "backlog",
      "todo",
      "in_progress",
      "done",
      "closed",
    ]);
    expect(taskStatusOptions(task("closed", owner("other")), "me")).toEqual([
      "closed",
      "backlog",
      "todo",
      "in_progress",
      "done",
    ]);
  });

  test("offers only the current status when the viewer has no membership", () => {
    expect(taskStatusOptions(task("todo"), null)).toEqual(["todo"]);
  });

  test("In Review shows only on a legacy In Review Task and is never a write target", () => {
    expect(
      taskStatusOptions(task("in_review", owner("me")), "me").filter((s) => s === "in_review"),
    ).toEqual(["in_review"]);
    for (const status of ["backlog", "todo", "in_progress", "done", "closed"] as const)
      expect(taskStatusOptions(task(status, owner("me")), "me")).not.toContain("in_review");
    expect(
      taskStatusOptions(task("todo", owner("me")), "me", { canSetAnyStatus: true }),
    ).not.toContain("in_review");
  });
});
