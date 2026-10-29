import { expect, test } from "bun:test";
import { run } from "../index";

const reminderId = "12345678-1234-4123-8123-123456789abc";
import type { ReminderSummaryRecord } from "@lrm/coforge-sdk/internal";
import { formatReminderResponse, formatReminderRow } from "../src/reminder-format";

const now = Date.parse("2026-10-29T10:00:00Z");

function reminder(overrides: Partial<ReminderSummaryRecord> = {}): ReminderSummaryRecord {
  return {
    reminderId: "abcdef12-0000-4000-8000-000000000001",
    ownerAgentId: "agent-1",
    version: 1,
    title: "Check the deploy",
    target: "#general",
    messageId: "msg-1",
    fireAt: "2026-10-30T09:00:00Z",
    status: "scheduled",
    createdAt: "2026-10-29T09:00:00Z",
    ...overrides,
  } as ReminderSummaryRecord;
}

test("a reminder row names its id8, cadence, next fire time and title", () => {
  expect(formatReminderRow(reminder(), now)).toBe(
    '#abcdef12 [scheduled] (one-time) next=2026-10-30T09:00:00Z "Check the deploy"',
  );
  expect(formatReminderRow(reminder({ repeat: "daily" }), now)).toBe(
    '#abcdef12 [scheduled] (recurring · daily) next=2026-10-30T09:00:00Z "Check the deploy"',
  );
});

test("a scheduled reminder whose fire time passed is marked OVERDUE", () => {
  expect(formatReminderRow(reminder({ fireAt: "2026-10-29T09:00:00Z" }), now)).toContain(
    "[OVERDUE]",
  );
  expect(
    formatReminderRow(reminder({ status: "fired", fireAt: "2026-10-29T09:00:00Z" }), now),
  ).not.toContain("[OVERDUE]");
});

test("an empty list says so plainly", () => {
  expect(
    formatReminderResponse("list", { accepted: true, reminders: [], events: [] } as never),
  ).toBe("No reminders.");
});

test("a schedule names the reminder it produced instead of saying Accepted", () => {
  expect(
    formatReminderResponse("schedule", {
      accepted: true,
      reminders: [reminder()],
      events: [],
    } as never),
  ).toBe('#abcdef12 [scheduled] (one-time) next=2026-10-30T09:00:00Z "Check the deploy"');
});
test("formats usable reminder lists, empty logs, and receipt acknowledgements", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const output = await run(["reminder", "list", "--all"], {
    ...base,
    reminder: async () => ({
      idempotencyKey: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      events: [],
      reminders: [
        {
          reminderId,
          ownerAgentId: "agent",
          version: 3,
          title: "Deploy",
          target: "#release",
          messageId: "deadbeef",
          fireAt: "2026-09-09T01:00:00Z",
          status: "scheduled",
          repeat: "every:1d",
          timezone: "Asia/Shanghai",
          createdAt: "2026-09-08T01:00:00Z",
        },
      ],
    }),
  });
  // The reference client's row: id8, status, cadence, next fire time, OVERDUE, quoted title.
  expect(output).toBe(
    `#${reminderId.slice(0, 8)} [scheduled] (recurring · every:1d) next=2026-09-09T01:00:00Z [OVERDUE] "Deploy"`,
  );
  expect(
    await run(["reminder", "log", "--id", reminderId], {
      ...base,
      reminder: async () => ({
        idempotencyKey: "request",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        accepted: true,
        reminders: [],
        events: [],
      }),
    }),
  ).toBe("No reminder events found.");
  expect(
    await run(["reminder", "ack", "--id", reminderId, "--revision", "3"], {
      ...base,
      reminder: async () => ({ accepted: true, reminderId, revision: 3 }),
    }),
  ).toContain(`id=${reminderId} revision=3`);
});

/** The creator and timestamps every Task read carries. */
