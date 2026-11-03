import { expect, test } from "bun:test";
import type { TaskMember, TaskResult, TaskView } from "@lrm/coforge-sdk/internal";
import {
  formatMyTaskList,
  formatTaskBoard,
  formatTaskShow,
  formatTaskStatusUpdated,
} from "#src/task-format";

const person = (handle: string, fields: Partial<TaskMember> = {}): TaskMember => ({
  memberId: `member-${handle}`,
  kind: "user",
  id: `user-${handle}`,
  name: handle,
  handle,
  ...fields,
});

const task = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
  id: `${number}abcdef0-1111-2222-3333-444444444444`,
  messageId: `${number}abcdef0-1111-2222-3333-444444444444`,
  conversationId: "conversation",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  blockedBy: [],
  blocked: false,
  parent: null,
  subtasks: null,
  owner: null,
  creator: person("ada"),
  createdAt: "2026-09-23T05:00:00.000Z",
  updatedAt: "2026-09-23T06:30:15.000Z",
  requiresResourceReceipt: false,
  resourceReceiptRecordedAt: null,
  ...fields,
});

const coverage: TaskResult["coverage"] = {
  status: "incomplete",
  visibleConversationKinds: ["channel", "dm"],
  includesArchived: true,
  inaccessibleScope: "not_asserted",
  reason: "Reads the channels and DMs this Agent is a member of now.",
};

// Task #470: each row shows its priority (`none` too, so the sorted levels read at a glance), the
// card names it, and an update says what it set.
test("Rows, cards and update receipts show the priority", () => {
  expect(
    formatTaskBoard("#general", { tasks: [task(5, { priority: "urgent" }), task(6)] }, undefined),
  ).toBe(
    [
      "## Task Board for #general (2 tasks)",
      "",
      "#5 [todo] prio=urgent Task 5 (by @ada) msg=5abcdef0-1111 rev=1 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z",
      "#6 [todo] prio=none Task 6 (by @ada) msg=6abcdef0-1111 rev=1 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z",
    ].join("\n"),
  );
  expect(
    formatMyTaskList(
      { tasks: [task(5, { priority: "high", channelRef: "#general" })], coverage },
      undefined,
    ),
  ).toContain("- #general task #5 [todo] prio=high by=@ada");
  expect(formatTaskShow(task(5, { priority: "medium" }))).toContain("\nPriority: medium");
  expect(formatTaskShow(task(5))).toContain("\nPriority: none");
  expect(formatTaskStatusUpdated(task(4, { status: "in_review", priority: "low" }))).toBe(
    "#4 moved to in_review.",
  );
  expect(formatTaskStatusUpdated(task(4, { priority: "low" }), { priority: "low" })).toBe(
    "#4 priority set to low.",
  );
  expect(
    formatTaskStatusUpdated(task(4, { status: "done", priority: "high" }), {
      status: "done",
      priority: "high",
    }),
  ).toBe("#4 moved to done, priority set to high.");
});
