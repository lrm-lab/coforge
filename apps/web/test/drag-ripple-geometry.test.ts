import { expect, test } from "bun:test";

import {
  closedSlots,
  gapAt,
  lineAt,
  ripple,
  sourceExtent,
} from "#src/components/ui/drag-ripple/ripple-geometry";

const slots = [
  { start: 0, size: 30 },
  { start: 32, size: 30 },
  { start: 64, size: 30 },
];

test("items lean away from the line, nearer ones sooner and further", () => {
  const shifts = [0, 1, 2, 3, 4].map((index) => ripple(index, 2, 10));
  expect(shifts.map((shift) => Number(shift.offset.toFixed(2)))).toEqual([-7, -10, 10, 7, 4.9]);
  expect(shifts.map((shift) => shift.delayMs)).toEqual([24, 0, 0, 24, 48]);
});

test("the picked item's slot is its size plus the spacing that follows it, or precedes the last", () => {
  expect(sourceExtent(slots, 1)).toBe(32);
  expect(sourceExtent(slots, 2)).toBe(32);
  expect(sourceExtent([{ start: 4, size: 30 }], 0)).toBe(30);
});

test("the slot closes up: later items move back by the picked item's extent", () => {
  expect(closedSlots(slots, 0)).toEqual([
    { start: 0, size: 30 },
    { start: 32, size: 30 },
  ]);
  expect(closedSlots(slots, null)).toEqual(slots);
});

test("the gap is the count of items whose middle the point has passed", () => {
  const closed = closedSlots(slots, 0);
  expect(gapAt(closed, 10)).toBe(0);
  expect(gapAt(closed, 20)).toBe(1);
  expect(gapAt(closed, 50)).toBe(2);
  expect(gapAt([], 50)).toBe(0);
});

test("the line sits halfway between its neighbours, or on the edge of the list", () => {
  expect(lineAt(slots, 1)).toBe(31);
  expect(lineAt(slots, 0)).toBe(0);
  expect(lineAt(slots, 3)).toBe(94);
  expect(lineAt([], 0)).toBe(0);
});
