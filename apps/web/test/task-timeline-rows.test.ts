import { describe, expect, test } from "bun:test";
import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import type { MessageView } from "#src/features/conversations/message-view";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { systemNoticeText } from "#src/features/conversations/system-notice-text";
import { taskEventNotice, withTaskEvents } from "#src/features/tasks/task-timeline-rows";

const people = {
  actor: (_type: "user" | "agent" | "system", handle: string | null) => ({
    memberId: null,
    handle: handle ?? "",
    displayName: handle === "ada" ? "Ada" : (handle ?? "Someone"),
  }),
  assignee: (_kind: "user" | "agent", id: string) => ({
    memberId: null,
    handle: id === "u-ada" ? "ada" : "bob",
    displayName: id === "u-ada" ? "Ada" : "Bob",
  }),
};
const subject = { number: 3 };

const event = (
  createdAt: string,
  change: Pick<TaskHistoryEvent, "eventType" | "payload">,
  actorName: string | null = "ada",
): TaskHistoryEvent =>
  ({
    id: `e-${createdAt}`,
    seq: 1,
    actorType: "user",
    actorName,
    createdAt,
    ...change,
  }) as TaskHistoryEvent;

const message = (sequence: number, createdAt: string, system?: SystemNotice) =>
  ({
    id: `m${sequence}`,
    sequence,
    senderKind: system ? "system" : "user",
    senderName: "Ada",
    body: "hello",
    createdAt,
    attachments: [],
    ...(system ? { system } : {}),
  }) as MessageView;

const text = (row: MessageView & { system?: SystemNotice }) => systemNoticeText(row, "en");

describe("taskEventNotice", () => {
  test("a status change reads as the Task moving", () => {
    const notice = taskEventNotice(
      event("2026-11-18T10:00:00Z", {
        eventType: "status_changed",
        payload: { from: "todo", to: "done" },
      }),
      subject,
      people,
    );
    expect(notice?.kind).toBe("task.moved");
  });

  test("taking a Task oneself reads as a claim, giving it to someone as an assignment", () => {
    const claim = taskEventNotice(
      event("2026-11-18T10:00:00Z", {
        eventType: "assignee_changed",
        payload: { assigneeId: "u-ada", assigneeType: "user" },
      }),
      subject,
      people,
    );
    const assignment = taskEventNotice(
      event("2026-11-18T10:00:00Z", {
        eventType: "assignee_changed",
        payload: { assigneeId: "u-bob", assigneeType: "user" },
      }),
      subject,
      people,
    );
    const release = taskEventNotice(
      event("2026-11-18T10:00:00Z", {
        eventType: "assignee_changed",
        payload: { assigneeId: null, assigneeType: null },
      }),
      subject,
      people,
    );
    expect([claim?.kind, assignment?.kind, release?.kind]).toEqual([
      "task.claimed",
      "task.assigned",
      "task.unassigned",
    ]);
  });

  test("a description change is a flag, never its text", () => {
    const row = withTaskEvents(
      [],
      [
        event("2026-11-18T10:00:00Z", {
          eventType: "amended",
          payload: { changes: { description: { from: "old secret", to: "new secret" } } },
        }),
      ],
      subject,
      people,
    )[0]!;
    expect(text(row)).toBe("✏️ Ada updated the description of #3");
  });
});

test("a priority reads in the reader's words, not its stored value", () => {
  const row = withTaskEvents(
    [],
    [
      event("2026-11-18T10:00:00Z", {
        eventType: "priority_changed",
        payload: { from: "none", to: "high" },
      }),
    ],
    subject,
    people,
  )[0]!;
  expect(text(row)).toBe("🏷️ Ada changed #3 priority from None to High");
});

test("a change that reads as nothing gets no row", () => {
  const rows = withTaskEvents(
    [],
    [
      event("2026-11-18T10:00:00Z", {
        eventType: "project_changed",
        payload: { from: null, to: null },
      }),
      event(
        "2026-11-18T10:01:00Z",
        {
          eventType: "labels_changed",
          payload: { added: [{ id: "l1", name: "ui", color: "blue" }], removed: [] },
        },
        null,
      ),
    ].map((row, index) => (index === 1 ? { ...row, actorType: "system" as const } : row)),
    subject,
    people,
  );
  expect(rows).toEqual([]);
});

describe("withTaskEvents", () => {
  const move = (at: string) =>
    event(at, { eventType: "status_changed", payload: { from: "todo", to: "in_progress" } });

  test("an event reads just before the first message at or after it, and after the last", () => {
    const rows = withTaskEvents(
      [message(4, "2026-11-18T10:00:00Z"), message(7, "2026-11-18T10:05:00Z")],
      [
        move("2026-11-18T09:00:00Z"),
        move("2026-11-18T10:05:00Z"),
        move("2026-11-18T10:06:00Z"),
        move("2026-11-18T10:07:00Z"),
      ],
      subject,
      people,
    );
    expect(rows.map((row) => row.id)).toEqual([
      "history:e-2026-11-18T09:00:00Z",
      "m4",
      "history:e-2026-11-18T10:05:00Z",
      "m7",
      "history:e-2026-11-18T10:06:00Z",
      "history:e-2026-11-18T10:07:00Z",
    ]);
  });

  test("an event row's sequence sits strictly between its neighbours' and never equals a message's", () => {
    const rows = withTaskEvents(
      [message(4, "2026-11-18T10:00:00Z"), message(5, "2026-11-18T10:05:00Z")],
      [move("2026-11-18T10:01:00Z"), move("2026-11-18T10:02:00Z"), move("2026-11-18T10:09:00Z")],
      subject,
      people,
    );
    const sequences = rows.map((row) => row.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    const events = rows.filter((row) => row.id.startsWith("history:"));
    expect(events.every((row) => !Number.isInteger(row.sequence))).toBe(true);
  });

  test("an addressed notice that repeats a change gives way to the change", () => {
    const assigned = message(4, "2026-11-18T10:00:00Z", {
      kind: "task.assigned_you",
      params: {
        actor: { memberId: null, handle: "ada", displayName: "Ada" },
        task: { taskId: null, number: 3, title: "Ship" },
      },
    });
    const priority = message(5, "2026-11-18T10:01:00Z", {
      kind: "task.priority_changed",
      params: {
        actor: { memberId: null, handle: "ada", displayName: "Ada" },
        task: { taskId: null, number: 3, title: "Ship" },
        from: "none",
        to: "high",
      },
    });
    const unfollowed = message(6, "2026-11-18T10:02:00Z", {
      kind: "task.unfollowed",
      params: {
        actor: { memberId: null, handle: "ada", displayName: "Ada" },
        task: { taskId: null, number: 3, title: "Ship" },
      },
    });
    const reply = message(7, "2026-11-18T10:03:00Z");
    const rows = withTaskEvents(
      [assigned, priority, unfollowed, reply],
      [move("2026-11-18T10:00:00Z")],
      subject,
      people,
    );
    expect(rows.map((row) => row.id)).toEqual(["history:e-2026-11-18T10:00:00Z", "m6", "m7"]);
  });

  test("with no events the messages are the stream as they are", () => {
    const messages = [message(4, "2026-11-18T10:00:00Z")];
    expect(withTaskEvents(messages, [], subject, people)).toEqual(messages);
  });
});
