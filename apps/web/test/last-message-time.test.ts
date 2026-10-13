import { expect, test } from "bun:test";

import { lastMessageTime } from "#src/features/conversations/last-message-time";

/**
 * A DM row's time: the clock when the last message is from today in the viewer's zone, else the
 * month and day. Shanghai is UTC+8, so 2026-10-09T01:00Z is 09:00 on the 9th there.
 */
const now = new Date("2026-10-09T15:30:00.000Z"); // 23:30 on 2026-10-09 in Shanghai
const shanghai = { now, locale: "en-US", timeZone: "Asia/Shanghai", timeFormat: "24h" as const };

test("a message from today shows its clock time in the viewer's zone", () => {
  expect(lastMessageTime("2026-10-09T01:00:00.000Z", shanghai)).toBe("09:00");
  // 04:00 on the 9th in Shanghai, though it is still the 8th in UTC.
  expect(lastMessageTime("2026-10-08T20:00:00.000Z", shanghai)).toBe("04:00");
});

test("a message from an earlier day shows its month and day", () => {
  // 23:00 on the 8th in Shanghai.
  expect(lastMessageTime("2026-10-08T15:00:00.000Z", shanghai)).toBe("Oct 8");
});

test("the clock follows the viewer's 12-hour choice, and the language's own when unset", () => {
  // The same clock as a message row's (two-digit hour).
  expect(lastMessageTime("2026-10-09T01:00:00.000Z", { ...shanghai, timeFormat: "12h" })).toBe(
    "09:00 AM",
  );
  expect(lastMessageTime("2026-10-09T01:00:00.000Z", { ...shanghai, timeFormat: null })).toBe(
    "09:00 AM",
  );
});
