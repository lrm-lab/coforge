import { expect, test } from "bun:test";
import type { ReminderJob } from "@lrm/coforge-sdk/internal";
import {
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
