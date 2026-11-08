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
