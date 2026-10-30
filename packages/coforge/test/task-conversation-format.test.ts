import { expect, test } from "bun:test";
import type { AgentTaskViewResponse } from "@lrm/coforge-sdk/agent";
import {
  formatTaskFollow,
  formatTaskFollowing,
  formatTaskReply,
  formatTaskView,
} from "../src/task-conversation-format";

const REF = "#general:#7";

const view = (overrides: Partial<AgentTaskViewResponse> = {}): AgentTaskViewResponse => ({
  taskRef: REF,
  task: { id: "t1", number: 7, title: "Fix the flaky test", status: "in_progress" },
  following: true,
  followReason: "manual",
  conversation: { exists: true, replyCount: 2 },
  recentMessages: [
    {
      id: "01a16c6c-1c04-77cc-ac0d-1ec28453613a",
      sequence: 1,
      body: "On it.\nWill report back.",
      createdAt: "2026-10-30T10:00:00.000Z",
      sender: "ada",
    },
    {
      id: "01a16c6c-1c05-77cc-ac0d-1ec28453613a",
      sequence: 2,
      body: "ada was assigned",
      createdAt: "2026-10-30T10:01:00.000Z",
      sender: null,
    },
  ],
  hasOlder: false,
  ...overrides,
});

test("a task with its conversation lists the messages oldest first and what to run next", () => {
  expect(formatTaskView(view())).toBe(
    [
      "## Task #general:#7 [in_progress]",
      "",
      "Current title: Fix the flaky test",
      "Assignee: unassigned",
      "Following: yes (manual) - its replies wake you",
      "Current description: (none set)",
      "",
      "Discussion (latest 2, oldest first):",
      "- [msg=01a16c6c-1c04-77cc-ac0d-1ec28453613a seq=1 time=2026-10-30 10:00:00Z] @ada: On it.",
      "  │ Will report back.",
      "- [msg=01a16c6c-1c05-77cc-ac0d-1ec28453613a seq=2 time=2026-10-30 10:01:00Z] system: ada was assigned",
      "",
      "Next:",
      '  Reply (the body is read from stdin): coforge task reply "#general:#7"',
      '  Read the discussion: coforge task read "#general:#7"',
      '  Stop following: coforge task unfollow "#general:#7"',
    ].join("\n"),
  );
});

test("the task's assignee, creator, source message and description head the view", () => {
  const text = formatTaskView(
    view({
      task: {
        id: "t1",
        number: 7,
        title: "Fix the flaky test",
        status: "todo",
        description: "See the CI log",
        owner: { handle: "kiro" },
        creator: { handle: "ada" },
        createdAt: "2026-10-30T09:00:00.000Z",
        sourceMessage: {
          messageId: "01a16c6c-1c03-77cc-ac0d-1ec28453613a",
          senderName: "bob",
          preview: "the flaky test again",
        },
      },
    }),
  );
  expect(text).toContain("Assignee: @kiro");
  expect(text).toContain("Created by: @ada at 2026-10-30 09:00:00Z");
  expect(text).toContain("Source: msg=01a16c6c-1c03 in #general - bob: the flaky test again");
  expect(text).toContain("Current description: See the CI log");
});

test("older messages are counted and point the read at the oldest shown", () => {
  const text = formatTaskView(
    view({ conversation: { exists: true, replyCount: 9 }, hasOlder: true }),
  );
  expect(text).toContain("Discussion (latest 2 of 9, oldest first):");
  expect(text).toContain(
    'Read the discussion: coforge task read "#general:#7" --before 01a16c6c-1c04',
  );
});

test("a task nobody has replied to says the first reply starts its conversation", () => {
  const text = formatTaskView(
    view({
      following: false,
      followReason: null,
      conversation: { exists: false, replyCount: 0 },
      recentMessages: [],
    }),
  );
  expect(text).toContain("Following: no - replies do not wake you unless you are @mentioned");
  expect(text).toContain("Discussion: none yet - the first reply starts the task's conversation.");
  expect(text).toContain('Follow: coforge task follow "#general:#7"');
});

test("a conversation with no messages in the window says so", () => {
  const text = formatTaskView(
    view({ recentMessages: [], conversation: { exists: true, replyCount: 0 } }),
  );
  expect(text).toContain("Discussion: no messages yet.");
});

test("a reply names its ref and message", () => {
  expect(formatTaskReply(REF, { messageId: "m1", sequence: 3 })).toBe(
    "Reply sent to #general:#7. Message ID: m1",
  );
});

test("follow and unfollow say whether anything changed and how to undo it", () => {
  const response = (following: boolean, changed: boolean) => ({
    ok: true as const,
    taskRef: REF,
    following,
    changed,
  });
  expect(formatTaskFollow(REF, response(true, true))).toBe(
    'Following #general:#7: its replies now wake you.\nTo stop: coforge task unfollow "#general:#7"',
  );
  expect(formatTaskFollow(REF, response(true, false))).toBe(
    'Already following #general:#7.\nTo stop: coforge task unfollow "#general:#7"',
  );
  expect(formatTaskFollow(REF, response(false, true))).toBe(
    [
      "Unfollowed #general:#7: its ordinary replies no longer wake you.",
      "A later @mention, being assigned the task or claiming it follows it again; replying in it does too.",
      'To follow again: coforge task follow "#general:#7"',
    ].join("\n"),
  );
  expect(formatTaskFollow(REF, response(false, false))).toContain("Not following #general:#7.");
});

test("the followed list gives each task's unread count and how to read it", () => {
  expect(
    formatTaskFollowing({
      tasks: [
        {
          taskRef: REF,
          taskNumber: 7,
          title: "Fix the\nflaky test",
          status: "todo",
          unread: 2,
          followedAt: "2026-10-30T10:00:00.000Z",
          reason: "assigned",
        },
        { taskRef: "dm:@ada:#1", title: "Hi", status: "done", unread: 0, reason: "manual" },
      ],
    }),
  ).toBe(
    [
      "## Task conversations you follow in your Workspace (2)",
      "",
      '- #general:#7 "Fix the flaky test" [todo] · 2 unread · coforge task read "#general:#7" --unread · followed 2026-10-30 10:00:00Z (assigned)',
      '- dm:@ada:#1 "Hi" [done] · 0 unread · (manual)',
      "",
      'Stop following one: coforge task unfollow "<ref>"',
    ].join("\n"),
  );
  expect(formatTaskFollowing({ tasks: [] })).toBe(
    "You follow no task conversations in your Workspace.",
  );
});
