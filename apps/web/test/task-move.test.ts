import { describe, expect, test } from "bun:test";
import type { TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { getTaskMoveCommand, taskStatusOptions } from "#src/features/tasks/task-move";

const task = (status: TaskStatus, owner: TaskView["owner"] = null): TaskView => ({
  messageId: "message-1",
  conversationId: "conversation-1",
  number: 7,
  title: "Move me",
  status,
  revision: 4,
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

const update = (status: TaskStatus) => ({
  operation: "update" as const,
  number: 7,
  status,
  expectedRevision: 4,
});

describe("getTaskMoveCommand", () => {
  test("does nothing without membership or when status is unchanged", () => {
    expect(getTaskMoveCommand(task("todo"), null, "in_progress")).toBeUndefined();
    expect(getTaskMoveCommand(task("in_review", owner("me")), "me", "in_review")).toBeUndefined();
  });

  test("claims an available or self-reserved todo moved to in progress", () => {
    expect(getTaskMoveCommand(task("todo"), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo", owner("me")), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo"), "me", "in_review")).toBeUndefined();
    expect(getTaskMoveCommand(task("todo"), "me", "done")).toBeUndefined();
  });

  test("an owner works their Task forward and back, exactly as the server allows", () => {
    const mine = owner("me");
    for (const nextStatus of ["in_review", "closed"] as const) {
      expect(getTaskMoveCommand(task("in_progress", mine), "me", nextStatus)).toEqual(
        update(nextStatus),
      );
    }
    // In progress does not go back to To do, and does not skip review on the way to Done.
    expect(getTaskMoveCommand(task("in_progress", mine), "me", "todo")).toBeUndefined();
    expect(getTaskMoveCommand(task("in_progress", mine), "me", "done")).toBeUndefined();
    for (const nextStatus of ["in_progress", "done", "closed"] as const) {
      expect(getTaskMoveCommand(task("in_review", mine), "me", nextStatus)).toEqual(
        update(nextStatus),
      );
    }
  });

  test("leaves in progress and in review to the owner, as the server does", () => {
    const someoneElses = task("in_review", owner("other"));
    expect(getTaskMoveCommand(someoneElses, "me", "in_progress")).toBeUndefined();
    expect(getTaskMoveCommand(task("todo", owner("other")), "me", "in_progress")).toBeUndefined();
    expect(
      getTaskMoveCommand(task("in_progress", owner("other")), "me", "in_review"),
    ).toBeUndefined();
    expect(getTaskMoveCommand(task("in_review"), "me", "in_progress")).toBeUndefined();
    // Someone else's In review Task may be finished or closed, not reopened to To do.
    expect(getTaskMoveCommand(someoneElses, "me", "todo")).toBeUndefined();
    for (const nextStatus of ["done", "closed"] as const) {
      expect(getTaskMoveCommand(someoneElses, "me", nextStatus)).toEqual(update(nextStatus));
    }
  });

  test("requires an owner for done but permits explicit terminal and todo updates", () => {
    expect(getTaskMoveCommand(task("in_review"), "me", "done")).toBeUndefined();
    expect(getTaskMoveCommand(task("in_review"), "me", "closed")).toEqual(update("closed"));
    expect(getTaskMoveCommand(task("done", owner("other")), "me", "todo")).toEqual(update("todo"));
  });

  test("a closed Task reopens to To do only, and a finished one may go back for rework", () => {
    expect(getTaskMoveCommand(task("closed", owner("me")), "me", "todo")).toEqual(update("todo"));
    expect(getTaskMoveCommand(task("closed", owner("me")), "me", "in_progress")).toBeUndefined();
    expect(getTaskMoveCommand(task("closed", owner("me")), "me", "done")).toBeUndefined();
    for (const nextStatus of ["todo", "in_progress", "in_review", "closed"] as const) {
      expect(getTaskMoveCommand(task("done", owner("me")), "me", nextStatus)).toEqual(
        update(nextStatus),
      );
    }
  });

  test("a Workspace owner or admin sets any status, on anyone's Task", () => {
    for (const from of ["todo", "in_progress", "in_review", "done", "closed"] as const)
      for (const to of ["todo", "in_progress", "in_review", "done", "closed"] as const) {
        if (from === to) continue;
        expect(
          getTaskMoveCommand(task(from, owner("other")), "me", to, { canSetAnyStatus: true }),
        ).toEqual(update(to));
      }
  });
});

describe("taskStatusOptions", () => {
  test("offers the current status first, then the statuses a Task may move to from it", () => {
    const mine = owner("me");
    expect(taskStatusOptions(task("todo", mine), "me")).toEqual(["todo", "in_progress", "closed"]);
    expect(taskStatusOptions(task("in_progress", mine), "me")).toEqual([
      "in_progress",
      "in_review",
      "closed",
    ]);
    expect(taskStatusOptions(task("in_review", mine), "me")).toEqual([
      "in_review",
      "in_progress",
      "done",
      "closed",
    ]);
    expect(taskStatusOptions(task("done", mine), "me")).toEqual([
      "done",
      "todo",
      "in_progress",
      "in_review",
      "closed",
    ]);
    expect(taskStatusOptions(task("closed", mine), "me")).toEqual(["closed", "todo"]);
  });

  test("drops moves the viewer cannot make", () => {
    expect(taskStatusOptions(task("in_review"), "me")).toEqual(["in_review", "closed"]);
    expect(taskStatusOptions(task("in_progress", owner("other")), "me")).toEqual([
      "in_progress",
      "closed",
    ]);
    expect(taskStatusOptions(task("todo"), null)).toEqual(["todo"]);
  });

  test("a manager's menu lists every other status", () => {
    expect(
      taskStatusOptions(task("closed", owner("other")), "me", { canSetAnyStatus: true }),
    ).toEqual(["closed", "todo", "in_progress", "in_review", "done"]);
  });
});
