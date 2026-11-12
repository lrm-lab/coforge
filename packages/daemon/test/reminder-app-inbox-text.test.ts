import { expect, test } from "bun:test";
import type { ReminderJob } from "@lrm/coforge-sdk/internal";
import type { AgentAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import {
  mergedReminderAppInboxNoticeText,
  reminderAppInboxNoticeText,
  reminderAppInboxPreview,
  reminderAppInboxSummary,
} from "#src/agent-reminder/reminder-app-inbox-text";

const job: ReminderJob = {
  reminderId: "123e4567-e89b-42d3-a456-426614174000",
  ownerAgentId: "agent-a",
  version: 3,
  title: "Review",
  target: "@frank",
  messageId: "123e4567-e89b-42d3-a456-426614174001",
  fireAt: "2026-09-08T12:00:01Z",
};

test("a reminder that fired on time says it is due", () => {
  expect(reminderAppInboxSummary(job, false)).toBe("Reminder due");
});

test("a reminder that fired late says so and when it was due", () => {
  expect(reminderAppInboxSummary(job, true)).toBe(
    "Overdue: was due 2026-09-08T12:00:01.000Z, delivered late",
  );
});

test("the preview is one bounded line without control characters", () => {
  expect(reminderAppInboxPreview("  a\tb\nc  ")).toBe("a b c");
  expect(reminderAppInboxPreview("x".repeat(200))).toHaveLength(120);
});

const dueItem = (overrides: Partial<AgentAppItem> = {}): AgentAppItem => ({
  itemId: "reminder:123e4567-e89b-42d3-a456-426614174000:1",
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: {
    kind: "reminder",
    id: "123e4567-e89b-42d3-a456-426614174000",
    revision: "1",
  },
  title: "Review",
  summary: "Reminder due",
  retention: "until_explicit_ack",
  action: { kind: "run_command", commandId: "reminder.ack" },
  command: "coforge reminder ack --id 123e4567-e89b-42d3-a456-426614174000 --revision 1",
  createdAt: "2026-09-08T12:00:01.000Z",
  ...overrides,
});

test("a due reminder's notice names its title, no invented due time, and the next step", () => {
  expect(reminderAppInboxNoticeText(dueItem())).toBe(
    "Reminder due: Review. Run coforge inbox check.",
  );
});

test("a late reminder's notice keeps its overdue detail", () => {
  expect(
    reminderAppInboxNoticeText(
      dueItem({
        summary: "Overdue: was due 2026-09-08T11:00:00.000Z, delivered late",
      }),
    ),
  ).toBe(
    "Reminder due: Review (Overdue: was due 2026-09-08T11:00:00.000Z, delivered late). Run coforge inbox check.",
  );
});

test("a backlog of due reminders merges into one notice naming the earliest", () => {
  const items = [
    dueItem({
      itemId: "reminder:123e4567-e89b-42d3-a456-426614174000:2",
      title: "Later",
      createdAt: "2026-09-08T13:00:00.000Z",
    }),
    dueItem({ title: "First", createdAt: "2026-09-08T12:00:01.000Z" }),
    dueItem({
      itemId: "reminder:123e4567-e89b-42d3-a456-426614174000:3",
      title: "Middle",
      createdAt: "2026-09-08T12:30:00.000Z",
    }),
  ];
  expect(mergedReminderAppInboxNoticeText(items)).toBe(
    "3 reminders due. Earliest: First. Run coforge inbox check.",
  );
});
