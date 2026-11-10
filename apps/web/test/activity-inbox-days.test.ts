import { expect, test } from "bun:test";
import { groupByDay } from "#src/features/inbox/activity-inbox-days";
import { formatClockTime } from "#src/lib/dates";

const now = Date.parse("2026-11-08T10:00:00Z");
const at = (item: { at: string }) => item.at;

test("a day is one group wherever its items sit in the list", () => {
  const items = [
    { id: "a", at: "2026-11-08T09:00:00Z" },
    { id: "b", at: "2026-11-05T09:00:00Z" },
    { id: "c", at: "2026-11-08T08:00:00Z" },
    { id: "d", at: "2026-11-07T09:00:00Z" },
    { id: "e", at: "2026-11-05T08:00:00Z" },
  ];
  const groups = groupByDay(items, at, "UTC", now);
  expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
    ["a", "c"],
    ["b", "e"],
    ["d"],
  ]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
});

test("the day is the viewer's, not UTC's", () => {
  const items = [{ id: "a", at: "2026-11-07T23:30:00Z" }];
  expect(groupByDay(items, at, "UTC", now)[0]!.key).toBe("2026-11-07");
  expect(groupByDay(items, at, "Asia/Shanghai", now)[0]!.key).toBe("2026-11-08");
});

test("a row's time of day belongs to the day its heading names, either side of midnight", () => {
  const items = [
    { id: "late", at: "2026-11-07T23:59:00Z" },
    { id: "early", at: "2026-11-08T00:01:00Z" },
  ];
  const groups = groupByDay(items, at, "UTC", now);
  expect(groups.map((group) => group.key)).toEqual(["2026-11-07", "2026-11-08"]);
  expect(
    groups.map((group) => formatClockTime(group.items[0]!.at, "UTC", "en-GB", null, false)),
  ).toEqual(["23:59", "00:01"]);
});

test("a 12-hour clock drops the hour's leading zero, a 24-hour one keeps it", () => {
  const at = "2026-11-08T09:49:00Z";
  expect(formatClockTime(at, "UTC", "en-US", "12h", false)).toBe("9:49 AM");
  expect(formatClockTime(at, "UTC", "en-GB", "24h", false)).toBe("09:49");
});

test("an older day names its weekday within this year and its year before it", () => {
  const items = [
    { id: "this-year", at: "2026-11-02T09:00:00Z" },
    { id: "last-year", at: "2025-12-31T09:00:00Z" },
  ];
  const [thisYear, lastYear] = groupByDay(items, at, "UTC", now).map((group) => group.label!);
  expect(thisYear).toMatch(/Monday/);
  expect(thisYear).not.toMatch(/2026/);
  expect(lastYear).toMatch(/2025/);
  expect(lastYear).not.toMatch(/Wednesday/);
});

// The server groups with the render's clock (task #68); these are the zones and instants where a
// day boundary is easiest to get wrong.
test("half-hour and far-east zones name the right day, a minute either side of their midnight", () => {
  // 18:30 UTC is midnight in Kolkata (UTC+5:30); 11:00 UTC is midnight in Tongatapu (UTC+13).
  const kolkata = [
    { id: "before", at: "2026-11-07T18:29:00Z" },
    { id: "after", at: "2026-11-07T18:31:00Z" },
  ];
  expect(groupByDay(kolkata, at, "Asia/Kolkata", now).map((group) => group.key)).toEqual([
    "2026-11-07",
    "2026-11-08",
  ]);
  const tonga = [
    { id: "before", at: "2026-11-07T10:59:00Z" },
    { id: "after", at: "2026-11-07T11:01:00Z" },
  ];
  expect(groupByDay(tonga, at, "Pacific/Tongatapu", now).map((group) => group.key)).toEqual([
    "2026-11-07",
    "2026-11-08",
  ]);
});

test("today follows the render's moment, a minute either side of the viewer's midnight", () => {
  const items = [{ id: "a", at: "2026-11-07T18:00:00Z" }];
  // Kolkata's 2026-11-08 begins at 2026-11-07T18:30Z: the item is that day's "yesterday" just after.
  const justBefore = Date.parse("2026-11-07T18:29:00Z");
  const justAfter = Date.parse("2026-11-07T18:31:00Z");
  expect(groupByDay(items, at, "Asia/Kolkata", justBefore)[0]!.label).toBe("Today");
  expect(groupByDay(items, at, "Asia/Kolkata", justAfter)[0]!.label).toBe("Yesterday");
});
