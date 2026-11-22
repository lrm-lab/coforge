import { expect, test } from "bun:test";

import { formatTaskCardDate } from "#src/features/tasks/task-card-date";

test("formatTaskCardDate omits the year in the current year and includes it across years", () => {
  const now = new Date("2026-11-22T12:00:00.000Z");

  expect(formatTaskCardDate("2026-01-01T12:00:00.000Z", "UTC", "en-US", now)).toBe("Jan 1");
  expect(formatTaskCardDate("1970-01-01T12:00:00.000Z", "UTC", "en-US", now)).toBe("Jan 1, 1970");
  expect(formatTaskCardDate("2030-01-01T12:00:00.000Z", "UTC", "en-US", now)).toBe("Jan 1, 2030");

  expect(formatTaskCardDate("2026-07-23T12:00:00.000Z", "UTC", "zh-CN", now)).toBe("7月23日");
  expect(formatTaskCardDate("2030-07-23T12:00:00.000Z", "UTC", "zh-CN", now)).toBe("2030.07.23");
});

test("formatTaskCardDate compares years in the viewer's time zone", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  expect(formatTaskCardDate("2026-01-01T02:00:00.000Z", "America/Los_Angeles", "en-US", now)).toBe(
    "Dec 31, 2025",
  );
  expect(formatTaskCardDate("2026-01-01T02:00:00.000Z", "Asia/Shanghai", "en-US", now)).toBe(
    "Jan 1",
  );
});
