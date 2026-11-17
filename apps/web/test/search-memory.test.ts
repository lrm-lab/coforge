import { expect, test } from "bun:test";

import {
  frequentEntities,
  searchEntityKey,
  withOpen,
  withSearch,
  type SearchUsage,
} from "#src/features/search/search-memory";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

test("a search joins the history newest first; the same text in another case counts once", () => {
  expect(withSearch(["a-phrase"], "E2E-Home-B")).toEqual(["E2E-Home-B", "a-phrase"]);
  expect(withSearch(["E2E-HOME-B", "a-phrase"], "e2e-home-b")).toEqual(["e2e-home-b", "a-phrase"]);
  expect(withSearch(["x"], "   ")).toEqual(["x"]);
  expect(
    withSearch(
      Array.from({ length: 15 }, (_, i) => `q${i}`),
      "new",
    ),
  ).toHaveLength(15);
});

test("only channels, Agents and direct messages are remembered", () => {
  expect(searchEntityKey({ kind: "channel", id: "1" })).toBe("channel:1");
  expect(searchEntityKey({ kind: "computer", id: "1" })).toBeUndefined();
});

test("the channel opened twice ranks first, then by recency", () => {
  let usage: SearchUsage = {};
  usage = withOpen(usage, "channel:a", NOW - 3 * MINUTE);
  usage = withOpen(usage, "channel:b", NOW - 2 * MINUTE);
  usage = withOpen(usage, "channel:b", NOW - MINUTE);
  expect(frequentEntities(usage, NOW, () => true).map(({ id }) => id)).toEqual(["b", "a"]);
});

test("frequently used shows ten usable places; an archived one gives its slot to the next", () => {
  // Channel 0 was opened most but is archived; 1-10 once each, newest first. Channel 1's open is
  // stamped two minutes ahead, as a clock that later stepped back would leave it.
  const usage: SearchUsage = {
    "channel:0": [NOW - 1000, NOW - 2000, NOW - 3000],
  };
  for (let i = 1; i <= 10; i++)
    usage[`channel:${i}`] = [i === 1 ? NOW + 2 * MINUTE : NOW - i * MINUTE];
  const ids = frequentEntities(usage, NOW, ({ id }) => id !== "0").map(({ id }) => id);
  expect(ids).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  // Opening another place keeps the open stamped slightly ahead.
  expect(withOpen(usage, "channel:5", NOW)["channel:1"]).toEqual([NOW + 2 * MINUTE]);
});

test("opens older than 90 days or far in the future no longer count", () => {
  const usage: SearchUsage = {
    "channel:old": [NOW - 91 * DAY],
    "channel:future": [NOW + 10 * MINUTE],
    "channel:ok": [NOW - DAY],
  };
  expect(frequentEntities(usage, NOW, () => true).map(({ id }) => id)).toEqual(["ok"]);
});
