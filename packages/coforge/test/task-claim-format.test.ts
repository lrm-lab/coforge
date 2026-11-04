import { expect, test } from "bun:test";
import type { TaskMember, TaskResult, TaskView } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { claimRefusal, formatClaimResults } from "#src/task-claim-format";

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

const heldBy = {
  kind: "claim_conflict" as const,
  conflictScope: "implementation_execution" as const,
  blockedActions: ["start_conflicting_execution" as const],
  unblockedActionExamples: ["reply in the task's thread", "read the task's history"],
  currentAssignee: { type: "agent" as const, name: "kiro" },
  taskStatus: "in_progress" as const,
  claimedAt: "2026-09-23T05:00:00.000Z",
  observedAt: "2026-09-23T06:00:00.000Z",
};

test("Claim results mark each selector claimed or refused, and name the holder of a held Task", () => {
  const result: TaskResult = {
    tasks: [task(42)],
    claims: [
      { number: 42, messageId: task(42).messageId!, success: true },
      { number: 43, success: false, reason: "already claimed", conflict: heldBy },
      { messageId: "abcd1234", success: false, reason: "message not found" },
    ],
  };
  expect(formatClaimResults("#general", result)).toBe(
    [
      "Claim results (1 claimed, 2 failed):",
      "#42 (msg:42abcdef0-111): claimed",
      "#43: Claim failed — @kiro currently holds the implementation lock (assignment state as of 2026-09-23T06:00:00.000Z).",
      "  Blocked: starting conflicting implementation/change work.",
      "  Not blocked by this claim conflict (each still subject to its own authority/policy): reply in the task's thread · read the task's history.",
      "  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted, correct the routing in the original thread.",
      "msg:abcd1234: FAILED — message not found. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.",
      "",
      "Follow up in each task's thread:",
      '#general:#42 → coforge message send --target "#general:42abcdef0-111"',
    ].join("\n"),
  );
  expect(claimRefusal("#general", result)).toBeUndefined();
});

test("A claim that authorises no work is refused with the rows, as a conflict when a Task is held", () => {
  const deletedHolder = {
    ...heldBy,
    currentAssignee: { type: "agent" as const, name: "old-bot", deleted: true },
  };
  const held = claimRefusal("#general", {
    tasks: [],
    claims: [
      { number: 43, success: false, reason: "already claimed", conflict: deletedHolder },
      { number: 44, success: false, reason: "task is closed" },
    ],
  });
  expect(held).toBeInstanceOf(CliError);
  expect(held).toMatchObject({
    code: "CLAIM_CONFLICT",
    message:
      "Claim refused — #43 held by @old-bot [deleted]; #44 task is closed. This is a concurrency lock or refusal, not a tool error and not a ruling on lane ownership.",
    suggestedNextAction:
      "Do not retry the identical claim and do not start conflicting execution. If you are this lane's canonical owner, correct the routing in the original thread.",
  });
  expect(held?.contextText).toStartWith(
    "Claim results (0 claimed, 2 failed):\n#43: Claim failed — @old-bot [deleted] currently holds",
  );
  expect(
    claimRefusal("#general", {
      tasks: [],
      claims: [{ number: 9, success: false, reason: "task not found" }],
    }),
  ).toMatchObject({ code: "CLAIM_FAILED" });
});

test("A claim refused for a blocker says what it waits for and what happens next", () => {
  const result = {
    tasks: [],
    claims: [
      {
        number: 5,
        success: false,
        reason: "blocked",
        blockedBy: [
          { hidden: false, number: 3, channel: "ops" },
          { hidden: false, number: 4, channel: null },
          { hidden: true },
        ],
      },
    ],
  } as TaskResult;
  const text = formatClaimResults("#c", result);
  expect(text).toContain("#5: blocked — waiting for #ops:#3 #4 a task in another channel");
  expect(text).toContain("notified");
  expect(claimRefusal("#c", result)?.message).toContain("blocked");
});

test("A claimed task without a source message still names its ref and a reply command", () => {
  const text = formatClaimResults("@ada", {
    tasks: [],
    claims: [{ number: 9, success: true }],
  });
  expect(text).toContain('dm:@ada:#9 → coforge task reply "dm:@ada:#9"');
});
