import { expect, test } from "bun:test";
import type { AgentTaskViewResponse } from "@lrm/coforge-sdk/agent";
import { historyEvent } from "./task-history-event-fixture";
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

test("view names the task's Project under its assignee, when the server sends one", () => {
  const filed = view({
    task: {
      id: "t1",
      number: 7,
      title: "Fix the flaky test",
      status: "in_progress",
      project: { id: "p1", name: "Task deps", slug: "task-deps" },
    },
  });
  expect(formatTaskView(filed)).toContain("Assignee: unassigned\nProject: Task deps (task-deps)\n");
  const none = view({ task: { id: "t1", number: 7, title: "x", status: "todo", project: null } });
  expect(formatTaskView(none)).toContain("Project: (none)");
  expect(formatTaskView(view())).not.toContain("Project:");
});

test("task view tells the Agent to verify a conflicting revision omitted from recall", () => {
  const approval = {
    id: "approval",
    revision: 1,
    title: "Rollout approved",
    content: "The rollout is ready.",
    source: "Review",
    applicability: "production",
    conflictsWith: [{ id: "objection", revision: 2 }],
  };
  const objection = { ...approval, id: "objection", revision: 2, conflictsWith: [] };
  expect(
    formatTaskView(view({ relatedMemory: [approval, { ...objection, revision: 1 }] })),
  ).toContain(
    "Some conflicting versions are missing from this summary. Check the full versions before acting.",
  );
  expect(formatTaskView(view({ relatedMemory: [approval, objection] }))).not.toContain(
    "Some conflicting versions are missing",
  );
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
  const dmText = formatTaskView(view({ taskRef: "dm:@ada:#7" }));
  expect(dmText).toContain(
    'Answer on the DM timeline (1-on-1 DM, unless they wrote in this task): coforge message send --target "@ada"',
  );
  const withReplies = formatTaskView(
    view({ earlierDiscussion: { target: "#general:01a16c6c-1c03", replyCount: 3 } }),
  );
  expect(withReplies).toContain(
    'Source thread discussion: #general:01a16c6c-1c03 - 3 replies; read with: coforge message read --target "#general:01a16c6c-1c03"',
  );
  const withOneReply = formatTaskView(
    view({ earlierDiscussion: { target: "@ada:01a16c6c-1c03", replyCount: 1 } }),
  );
  expect(withOneReply).toContain(
    'Source thread discussion: @ada:01a16c6c-1c03 - 1 reply; read with: coforge message read --target "@ada:01a16c6c-1c03"',
  );
  expect(
    formatTaskView(
      view({ earlierDiscussion: { target: "#general:01a16c6c-1c03", replyCount: 0 } }),
    ),
  ).not.toContain("Source thread discussion:");
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

test("history events join the messages in one time-ordered stream, an event first at a tie", () => {
  const text = formatTaskView(
    view({
      recentEvents: [
        historyEvent(2, "2026-10-30T10:01:00.000Z", {
          eventType: "status_changed",
          payload: { from: "todo", to: "in_progress" },
        }),
        historyEvent(1, "2026-10-30T09:00:00.000Z", {
          eventType: "assignee_changed",
          payload: { assigneeId: "u1", assigneeType: "user" },
        }),
      ],
    }),
  );
  const lines = text.split("\n").filter((line) => line.startsWith("- ["));
  expect(text).toContain("Discussion and history (latest 4, oldest first):");
  expect(
    lines.map((line) => line.match(/^- \[(\w+)/)![1] + ":" + line.match(/seq=(\d+)/)![1]),
  ).toEqual(["event:1", "msg:1", "event:2", "msg:2"]);
  expect(lines[0]).toBe(
    '- [event seq=1 time=2026-10-30 09:00:00Z actor=@bob type=assignee_changed] {"assigneeId":"u1","assigneeType":"user"}',
  );
});

test("a description change is a flag in the stream, never its text", () => {
  const text = formatTaskView(
    view({
      recentMessages: [],
      recentEvents: [
        historyEvent(1, "2026-10-30T09:00:00.000Z", {
          eventType: "amended",
          payload: {
            changes: { description: { from: "old secret", to: "new secret" } },
            revision: 2,
          },
        }),
        historyEvent(2, "2026-10-30T09:01:00.000Z", {
          eventType: "amended",
          payload: {
            changes: { title: { from: "a", to: "b" }, description: { from: "x", to: "y" } },
          },
        }),
      ],
    }),
  );
  expect(text).toContain("type=amended] updated the description\n");
  expect(text).toContain('{"changes":{"title":{"from":"a","to":"b"}}} updated the description');
  expect(text).not.toContain("secret");
  expect(text).not.toContain('"y"');
});

test("a task with events but no conversation still shows its history, and older ones are flagged", () => {
  const text = formatTaskView(
    view({
      conversation: { exists: false, replyCount: 0 },
      recentMessages: [],
      hasOlder: true,
      recentEvents: [
        historyEvent(9, "2026-10-30T09:00:00.000Z", {
          eventType: "priority_changed",
          payload: { from: "none", to: "high" },
        }),
      ],
    }),
  );
  expect(text).toContain("Discussion and history (latest 1, older exist, oldest first):");
  expect(text).toContain("type=priority_changed");
  expect(text).toContain('Read the discussion: coforge task read "#general:#7"\n');
  expect(text).toContain('Every recorded change: coforge task history "#general:#7"');
});
