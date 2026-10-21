import { expect, test } from "bun:test";

import { adjacentReportTabId } from "#src/features/records/report-tab-keyboard";

const tabs = ["Summary", "Research", "Technique", "Achievements"];

test("Tab moves to the next report tab and stops after the last", () => {
  expect(adjacentReportTabId(tabs, "Summary", false)).toBe("Research");
  expect(adjacentReportTabId(tabs, "Technique", false)).toBe("Achievements");
  expect(adjacentReportTabId(tabs, "Achievements", false)).toBeNull();
});

test("Shift+Tab moves to the previous report tab and stops before the first", () => {
  expect(adjacentReportTabId(tabs, "Research", true)).toBe("Summary");
  expect(adjacentReportTabId(tabs, "Summary", true)).toBeNull();
  expect(adjacentReportTabId(tabs, "Missing", false)).toBeNull();
});
