import { expect, test } from "bun:test";

import { presenceSummary } from "#src/features/artifacts/artifact-presence-summary";

test("alone on the page with nobody else on the latest: no summary", () => {
  expect(presenceSummary({ othersViewing: 0, youViewing: true, seenLatest: 0 })).toEqual([]);
});

test("others viewing, nobody else on the latest: the zero part is left out", () => {
  expect(presenceSummary({ othersViewing: 2, youViewing: true, seenLatest: 0 })).toEqual([
    { kind: "viewing", count: 2 },
    { kind: "you" },
  ]);
});

test("alone, but others saw the latest earlier: the summary has something to say", () => {
  expect(presenceSummary({ othersViewing: 0, youViewing: true, seenLatest: 3 })).toEqual([
    { kind: "you" },
    { kind: "sawLatest", count: 3 },
  ]);
});

test("twenty people, half of them behind", () => {
  expect(presenceSummary({ othersViewing: 10, youViewing: true, seenLatest: 10 })).toEqual([
    { kind: "viewing", count: 10 },
    { kind: "you" },
    { kind: "sawLatest", count: 10 },
  ]);
});
