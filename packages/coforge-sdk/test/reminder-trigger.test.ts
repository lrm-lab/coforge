import { expect, test } from "bun:test";
import {
  REMINDER_TRIGGER_DETAILS_MAX_BYTES,
  REMINDER_TRIGGER_TITLE_MAX_CHARS,
  parseReminderTriggerKey,
  parseReminderTriggerLevel,
  parseReminderTriggerMergeWindowSeconds,
  validateReminderTriggerDetails,
  validateReminderTriggerTitle,
} from "../src/internal/reminder-trigger";

test("a trigger key names a condition in 1 to 64 safe characters ending in a letter or digit", () => {
  for (const key of ["a", "slip_BTC", "feed.down:eu-1", "x".repeat(64)])
    expect(parseReminderTriggerKey(key)).toEqual({ ok: true, key });
  for (const key of ["", " ", "a b", "ends-", "ends.", "_", "x".repeat(65), "café", "a\nb"])
    expect(parseReminderTriggerKey(key).ok).toBe(false);
});

test("the coforge. prefix is reserved for the system's own keys", () => {
  expect(parseReminderTriggerKey("coforge.tasks")).toEqual({
    ok: false,
    reason: "reserved_prefix",
  });
  expect(parseReminderTriggerKey("coforge.tasks", { allowReserved: true })).toEqual({
    ok: true,
    key: "coforge.tasks",
  });
  expect(parseReminderTriggerKey("coforgeish").ok).toBe(true);
  for (const key of ["Coforge.tasks", "COFORGE.x", "cOfOrGe.y"])
    expect(parseReminderTriggerKey(key)).toEqual({ ok: false, reason: "reserved_prefix" });
});

test("a key is taken as written: no trimming, no case folding", () => {
  expect(parseReminderTriggerKey(" slip").ok).toBe(false);
  expect(parseReminderTriggerKey("Slip")).toEqual({ ok: true, key: "Slip" });
});

test("a level is wake or log, and wake is the default", () => {
  expect(parseReminderTriggerLevel(undefined)).toBe("wake");
  expect(parseReminderTriggerLevel("log")).toBe("log");
  expect(parseReminderTriggerLevel("WAKE")).toBe("wake");
  expect(parseReminderTriggerLevel("loud")).toBeUndefined();
});

test("a merge window is 1 minute to 24 hours and defaults to 10 minutes", () => {
  expect(parseReminderTriggerMergeWindowSeconds(undefined)).toBe(600);
  expect(parseReminderTriggerMergeWindowSeconds(60)).toBe(60);
  expect(parseReminderTriggerMergeWindowSeconds(86_400)).toBe(86_400);
  expect(parseReminderTriggerMergeWindowSeconds(59)).toBeUndefined();
  expect(parseReminderTriggerMergeWindowSeconds(86_401)).toBeUndefined();
  expect(parseReminderTriggerMergeWindowSeconds(90.5)).toBeUndefined();
});

test("a title is one non-blank line within its length limit", () => {
  expect(validateReminderTriggerTitle("BTC slipped 2.1%")).toBe(true);
  expect(validateReminderTriggerTitle("t".repeat(REMINDER_TRIGGER_TITLE_MAX_CHARS))).toBe(true);
  expect(validateReminderTriggerTitle("t".repeat(REMINDER_TRIGGER_TITLE_MAX_CHARS + 1))).toBe(
    false,
  );
  expect(validateReminderTriggerTitle("\u{1F600}".repeat(REMINDER_TRIGGER_TITLE_MAX_CHARS))).toBe(
    true,
  );
  expect(
    validateReminderTriggerTitle("\u{1F600}".repeat(REMINDER_TRIGGER_TITLE_MAX_CHARS + 1)),
  ).toBe(false);
  for (const title of ["", "   ", "a\nb", "a\u0007b"])
    expect(validateReminderTriggerTitle(title)).toBe(false);
});

test("details are bounded in bytes, not characters", () => {
  expect(validateReminderTriggerDetails("d".repeat(REMINDER_TRIGGER_DETAILS_MAX_BYTES))).toBe(true);
  expect(validateReminderTriggerDetails("d".repeat(REMINDER_TRIGGER_DETAILS_MAX_BYTES + 1))).toBe(
    false,
  );
  const threeBytesEach = "中".repeat(Math.floor(REMINDER_TRIGGER_DETAILS_MAX_BYTES / 3) + 1);
  expect(validateReminderTriggerDetails(threeBytesEach)).toBe(false);
});
