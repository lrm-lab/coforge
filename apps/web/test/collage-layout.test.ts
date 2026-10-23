import { expect, test } from "bun:test";

import { collageLayout, type CollageSlot } from "#src/features/conversations/collage-layout";

const sizes = (slots: readonly CollageSlot[]) => slots.map((slot) => slot.size);
const centre = (slot: CollageSlot) => [slot.left + slot.size / 2, slot.top + slot.size / 2];
/** How far two slots overlap along each axis, as a fraction of the frame. */
const overlap = (a: CollageSlot, b: CollageSlot) => [
  Math.min(a.left + a.size, b.left + b.size) - Math.max(a.left, b.left),
  Math.min(a.top + a.size, b.top + b.size) - Math.max(a.top, b.top),
];

test("No members has no collage: the row shows the channel icon", () => {
  expect(collageLayout(0)).toEqual([]);
  expect(collageLayout(-3)).toEqual([]);
});

test("One member fills the circle", () => {
  const [only] = collageLayout(1) as [CollageSlot];
  expect(collageLayout(1)).toHaveLength(1);
  expect([only.left, only.top, only.size, only.overflow]).toEqual([0, 0, 1, false]);
});

// Frank's references (2026-10-23): member stickers about 55-60% of the frame, overlapping each
// other like stickers on a sheet; a later member is drawn over an earlier one.
test("Two members overlap diagonally, the second lower right and drawn over the first", () => {
  const [first, second] = collageLayout(2) as [CollageSlot, CollageSlot];
  expect(second.left).toBeGreaterThan(first.left);
  expect(second.top).toBeGreaterThan(first.top);
  for (const along of overlap(first, second)) expect(along).toBeGreaterThan(0.15);
  for (const size of sizes(collageLayout(2))) {
    expect(size).toBeGreaterThanOrEqual(0.55);
    expect(size).toBeLessThanOrEqual(0.65);
  }
});

test("Three members: one at the top centre behind, two overlapping at the bottom left and right", () => {
  const [top, left, right] = collageLayout(3) as [CollageSlot, CollageSlot, CollageSlot];
  expect(centre(top)[0]).toBeCloseTo(0.5, 1);
  expect(left.top).toBeGreaterThan(top.top + 0.25);
  expect(right.top).toBeGreaterThan(top.top + 0.25);
  expect(centre(left)[0]).toBeLessThan(0.4);
  expect(centre(right)[0]).toBeGreaterThan(0.6);
  // The bottom pair overlap each other and both tuck under the top one's lower edge.
  expect(overlap(left, right)[0]).toBeGreaterThan(0.05);
  expect(overlap(top, left)[1]).toBeGreaterThan(0);
  expect(overlap(top, right)[1]).toBeGreaterThan(0);
  for (const size of sizes(collageLayout(3))) {
    expect(size).toBeGreaterThanOrEqual(0.55);
    expect(size).toBeLessThanOrEqual(0.6);
  }
});

test("Four members form a tight 2 by 2: top-left, top-right, bottom-left, bottom-right", () => {
  const [a, b, c, d] = collageLayout(4) as [CollageSlot, CollageSlot, CollageSlot, CollageSlot];
  expect(Math.abs(a.top - b.top)).toBeLessThan(0.05);
  expect(Math.abs(c.top - d.top)).toBeLessThan(0.05);
  expect(b.left).toBeGreaterThan(a.left + 0.25);
  expect(d.left).toBeGreaterThan(c.left + 0.25);
  expect(c.top).toBeGreaterThan(a.top + 0.25);
  // Neighbours overlap a little, so the four read as one cluster.
  expect(overlap(a, b)[0]).toBeGreaterThan(0);
  expect(overlap(a, c)[1]).toBeGreaterThan(0);
  expect(overlap(c, d)[0]).toBeGreaterThan(0);
  expect(overlap(b, d)[1]).toBeGreaterThan(0);
  for (const size of sizes(collageLayout(4))) {
    expect(size).toBeGreaterThanOrEqual(0.5);
    expect(size).toBeLessThanOrEqual(0.56);
  }
  expect(collageLayout(4).some((slot) => slot.overflow)).toBe(false);
});

test("Never more than four slots; the fourth is the overflow dots only above four members", () => {
  for (const count of [5, 6, 10, 200]) {
    const slots = collageLayout(count);
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.overflow)).toEqual([false, false, false, true]);
    expect(sizes(slots)).toEqual(sizes(collageLayout(4)));
  }
  for (const count of [1, 2, 3, 4]) {
    expect(collageLayout(count)).toHaveLength(count);
  }
});

test("A cluster sits centred on the circle and passes its square only slightly", () => {
  for (const count of [2, 3, 4, 5]) {
    const slots = collageLayout(count);
    const left = Math.min(...slots.map((slot) => slot.left));
    const top = Math.min(...slots.map((slot) => slot.top));
    const right = Math.max(...slots.map((slot) => slot.left + slot.size));
    const bottom = Math.max(...slots.map((slot) => slot.top + slot.size));
    expect(left).toBeGreaterThanOrEqual(-0.05);
    expect(top).toBeGreaterThanOrEqual(-0.05);
    expect(right).toBeLessThanOrEqual(1.05);
    expect(bottom).toBeLessThanOrEqual(1.05);
    expect((left + right) / 2).toBeCloseTo(0.5, 1);
    expect((top + bottom) / 2).toBeCloseTo(0.5, 1);
  }
});

test("Initials keep a readable floor at the small frame", () => {
  for (const count of [1, 2, 3, 4, 5]) {
    for (const slot of collageLayout(count)) {
      expect(slot.css.fontSize.startsWith("max(0.625rem,")).toBe(true);
    }
  }
});
