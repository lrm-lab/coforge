import { expect, setSystemTime, test } from "bun:test";
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
    '#abcdef12 [scheduled] (one-time) next=2026-10-30T09:00:00Z (UTC; account time zone unknown) "Check the deploy"',
  );
  expect(formatReminderRow(reminder(), now, undefined, "Asia/Shanghai")).toBe(
    '#abcdef12 [scheduled] (one-time) next=2026-10-30 17:00 Asia/Shanghai (2026-10-30T09:00:00Z) "Check the deploy"',
  );
  expect(formatReminderRow(reminder({ repeat: "daily" }), now, undefined, "Asia/Shanghai")).toBe(
    '#abcdef12 [scheduled] (recurring · daily) next=2026-10-30 17:00 Asia/Shanghai (2026-10-30T09:00:00Z) "Check the deploy"',
  );
});

test("the account's display zone wins while cadence keeps the reminder's zone", () => {
  expect(
    formatReminderRow(
      reminder({ repeat: "daily", timezone: "America/New_York" }),
      now,
      undefined,
      "Asia/Shanghai",
    ),
  ).toBe(
    '#abcdef12 [scheduled] (recurring · daily (America/New_York)) next=2026-10-30 17:00 Asia/Shanghai (2026-10-30T09:00:00Z) "Check the deploy"',
  );
  expect(
    formatReminderRow(
      reminder({ repeat: "daily", timezone: "Not/A_Zone" }),
      now,
      undefined,
      "Asia/Shanghai",
    ),
  ).toContain("next=2026-10-30 17:00 Asia/Shanghai (2026-10-30T09:00:00Z)");
  expect(
    formatReminderRow(reminder({ timezone: "America/New_York" }), now, undefined, "Not/A_Zone"),
  ).toContain("next=2026-10-30 05:00 America/New_York (2026-10-30T09:00:00Z)");
  expect(formatReminderRow(reminder(), now, undefined, "Not/A_Zone")).toContain(
    "next=2026-10-30T09:00:00Z (UTC; account time zone unknown)",
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

test("a log line's next fire time uses the account's zone, and stays bare when there is none", () => {
  const event = { eventId: "evt-1", type: "scheduled", time: "2026-10-29T10:00:00Z" };
  expect(
    formatReminderResponse("log", {
      accepted: true,
      displayTimezone: "Asia/Shanghai",
      reminders: [],
      events: [{ ...event, nextFireAt: "2026-10-30T09:00:00Z" }],
    } as never),
  ).toBe(
    "event=evt-1 type=scheduled time=2026-10-29T10:00:00Z next=2026-10-30 17:00 Asia/Shanghai (2026-10-30T09:00:00Z)",
  );
  expect(
    formatReminderResponse("log", {
      accepted: true,
      reminders: [],
      events: [{ ...event, nextFireAt: "2026-10-30T09:00:00Z" }],
    } as never),
  ).toBe(
    "event=evt-1 type=scheduled time=2026-10-29T10:00:00Z next=2026-10-30T09:00:00Z (UTC; account time zone unknown)",
  );
  expect(
    formatReminderResponse("log", { accepted: true, reminders: [], events: [event] } as never),
  ).toBe("event=evt-1 type=scheduled time=2026-10-29T10:00:00Z next=-");
});

test("a local time keeps midnight at 00:00 and follows the zone across DST", () => {
  expect(
    formatReminderRow(reminder({ fireAt: "2026-10-29T16:00:00Z", timezone: "Asia/Shanghai" }), now),
  ).toContain("next=2026-10-30 00:00 Asia/Shanghai (2026-10-29T16:00:00Z)");
  expect(
    formatReminderRow(
      reminder({ fireAt: "2027-03-14T10:00:00Z", timezone: "America/Los_Angeles" }),
      now,
    ),
  ).toContain("next=2027-03-14 03:00 America/Los_Angeles (2027-03-14T10:00:00Z)");
  expect(
    formatReminderRow(
      reminder({ fireAt: "2027-11-07T09:00:00Z", timezone: "America/Los_Angeles" }),
      now,
    ),
  ).toContain("next=2027-11-07 01:00 America/Los_Angeles (2027-11-07T09:00:00Z)");
});

test("a schedule names the reminder it produced instead of saying Accepted", () => {
  setSystemTime(now);
  try {
    expect(
      formatReminderResponse("schedule", {
        accepted: true,
        displayTimezone: "Asia/Shanghai",
        reminders: [reminder()],
        events: [],
      } as never),
    ).toBe(
      '#abcdef12 [scheduled] (one-time) next=2026-10-30 17:00 Asia/Shanghai (2026-10-30T09:00:00Z) "Check the deploy"',
    );
  } finally {
    setSystemTime();
  }
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
    `#${reminderId.slice(0, 8)} [scheduled] (recurring · every:1d (Asia/Shanghai)) next=2026-09-09 09:00 Asia/Shanghai (2026-09-09T01:00:00Z) [OVERDUE] "Deploy"`,
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

test("a list lengthens a short id only as far as needed to tell colliding reminders apart", () => {
  setSystemTime(now);
  try {
    const first = reminder({ reminderId: "01a1edf8-1111-7000-8000-000000000001" });
    const second = reminder({ reminderId: "01a1edf8-1211-7000-8000-000000000002" });
    const third = reminder({ reminderId: "abcdef12-0000-4000-8000-000000000003" });
    const lines = formatReminderResponse("list", {
      accepted: true,
      reminders: [first, second, third],
      events: [],
    } as never).split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "#01a1edf811",
      "#01a1edf812",
      "#abcdef12",
    ]);
  } finally {
    setSystemTime();
  }
});
