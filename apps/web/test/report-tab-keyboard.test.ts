import { expect, test } from "bun:test";

import {
  adjacentReportTabId,
  nextReportTabIdFromKey,
} from "#src/features/records/report-tab-keyboard";

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

test("Arrow, Home, End, and Tab keys navigate report tabs", () => {
  expect(nextReportTabIdFromKey(tabs, "Summary", "ArrowRight", false)).toBe("Research");
  expect(nextReportTabIdFromKey(tabs, "Achievements", "ArrowRight", false)).toBe("Summary");
  expect(nextReportTabIdFromKey(tabs, "Summary", "ArrowLeft", false)).toBe("Achievements");
  expect(nextReportTabIdFromKey(tabs, "Technique", "Home", false)).toBe("Summary");
  expect(nextReportTabIdFromKey(tabs, "Summary", "End", false)).toBe("Achievements");
  expect(nextReportTabIdFromKey(tabs, "Summary", "Tab", false)).toBe("Research");
  expect(nextReportTabIdFromKey(tabs, "Summary", "Tab", true)).toBeNull();
  expect(nextReportTabIdFromKey(["Summary"], "Summary", "ArrowRight", false)).toBeNull();
  expect(nextReportTabIdFromKey(tabs, "Summary", "Enter", false)).toBeNull();
});
