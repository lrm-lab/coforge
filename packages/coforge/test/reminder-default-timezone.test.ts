import { expect, test } from "bun:test";
import { parseArgs } from "../index";
import { formatReminderRow } from "#src/reminder-format";

test("CLI omits timezone when --tz is not passed instead of defaulting to Asia/Shanghai", () => {
  const parsed = parseArgs([
    "reminder",
    "schedule",
    "--target",
    "@ada",
    "--message-id",
    "12345678-1234-4123-8123-123456789abc",
    "--title",
    "Standup",
    "--repeat",
    "every:1d",
  ]);
  expect(parsed).toMatchObject({
    command: "reminder",
    operation: "schedule",
    repeat: "every:1d",
  });
  expect("timezone" in parsed ? parsed.timezone : undefined).toBeUndefined();
});

test("CLI preserves explicit --tz including legacy Asia/Shanghai", () => {
  expect(
    parseArgs([
      "reminder",
      "schedule",
      "--target",
      "@ada",
      "--message-id",
      "12345678-1234-4123-8123-123456789abc",
      "--title",
      "Standup",
      "--repeat",
      "every:1d",
      "--tz",
      "America/Los_Angeles",
    ]),
  ).toMatchObject({ timezone: "America/Los_Angeles" });

  expect(
    parseArgs([
      "reminder",
      "schedule",
      "--target",
      "@ada",
      "--message-id",
      "12345678-1234-4123-8123-123456789abc",
      "--title",
      "Standup",
      "--repeat",
      "every:1d",
      "--tz",
      "Asia/Shanghai",
    ]),
  ).toMatchObject({ timezone: "Asia/Shanghai" });
});

test("formatReminderRow displays the reminder's resolved timezone in receipts and list", () => {
  const beforeItFires = Date.parse("2026-11-19T12:00:00.000Z");
  expect(
    formatReminderRow(
      {
        reminderId: "12345678-1234-4123-8123-123456789abc",
        ownerAgentId: "agent-1",
        version: 1,
        title: "Standup",
        target: "@ada",
        messageId: "msg-1",
        fireAt: "2026-11-19T17:00:00.000Z",
        repeat: "daily 09:00",
        timezone: "America/Los_Angeles",
        status: "scheduled",
        createdAt: "2026-11-18T00:00:00.000Z",
      },
      beforeItFires,
    ),
  ).toBe(
    '#12345678 [scheduled] (recurring · daily 09:00 (America/Los_Angeles)) next=2026-11-19T17:00:00.000Z "Standup"',
  );
});
