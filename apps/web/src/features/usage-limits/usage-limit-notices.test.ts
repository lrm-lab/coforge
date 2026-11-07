import { expect, test } from "bun:test";

import { markNotices, unseenNotices, visibleNotices } from "./usage-limit-notices";

const notice = (id: string, seenAt: Date | null, dismissedAt: Date | null) => ({
  id,
  viewer: { seenAt, dismissedAt },
});
const at = new Date("2026-11-07T00:00:00Z");

test("a dismissed event is neither shown nor counted, seen or not", () => {
  const events = [notice("a", null, null), notice("b", at, null), notice("c", null, at)];
  expect(visibleNotices(events).map((event) => event.id)).toEqual(["a", "b"]);
  expect(unseenNotices(events).map((event) => event.id)).toEqual(["a"]);
});

test("marking keeps the earliest time and leaves the other events alone", () => {
  const earlier = new Date("2026-11-06T00:00:00Z");
  const marked = markNotices(
    [notice("a", earlier, null), notice("b", null, null), notice("c", null, null)],
    ["a", "b"],
    "seenAt",
    at,
  );
  expect(marked.map((event) => event.viewer.seenAt)).toEqual([earlier, at, null]);
});
