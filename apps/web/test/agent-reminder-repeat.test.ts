import { afterEach, expect, test } from "bun:test";
import { formatRecurrence } from "#src/features/agents/agent-reminder-repeat";
import { overwriteGetLocale } from "#src/paraglide/runtime";

afterEach(() => overwriteGetLocale(() => "en"));

const read = (rule: string): string => formatRecurrence(rule);

// Task #126: "Every 1 hours" read as a broken sentence; one of a unit is named without its count.
test("a repeat rule reads as a sentence in English and Chinese", () => {
  const cases = ["every:1m", "every:15m", "every:1h", "every:4h", "every:1d", "every:3d"];
  overwriteGetLocale(() => "en");
  expect(cases.map(read)).toEqual([
    "Every minute",
    "Every 15 minutes",
    "Every hour",
    "Every 4 hours",
    "Every day",
    "Every 3 days",
  ]);
  expect(read("daily@09:30")).toBe("Daily at 09:30");
  expect(read("weekly:mon,wed@09:00")).toBe("Weekly on Mon, Wed at 09:00");
  overwriteGetLocale(() => "zh-CN");
  expect(cases.map(read)).toEqual([
    "每分钟",
    "每 15 分钟",
    "每小时",
    "每 4 小时",
    "每天",
    "每 3 天",
  ]);
  expect(read("daily@09:30")).toBe("每天 09:30");
  expect(read("weekly:mon,wed@09:00")).toBe("每周一、周三 09:00");
});
