import { expect, test } from "bun:test";

import { collageLayout, type CollageSlot } from "#src/features/conversations/collage-layout";

const sizes = (slots: readonly CollageSlot[]) => slots.map((slot) => slot.size);

test("No members has no collage: the row shows the channel icon", () => {
  expect(collageLayout(0)).toEqual([]);
  expect(collageLayout(-3)).toEqual([]);
});

test("One member fills the circle", () => {
  const [only] = collageLayout(1) as [CollageSlot];
  expect(collageLayout(1)).toHaveLength(1);
  expect([only.left, only.top, only.size, only.overflow]).toEqual([0, 0, 1, false]);
});

test("Two members sit diagonally, top-left under bottom-right, overlapping", () => {
  const [first, second] = collageLayout(2) as [CollageSlot, CollageSlot];
  expect(first.left).toBeLessThan(second.left);
  expect(first.top).toBeLessThan(second.top);
  expect(first.left + first.size).toBeGreaterThan(second.left);
  expect(first.top + first.size).toBeGreaterThan(second.top);
  expect(collageLayout(2).some((slot) => slot.overflow)).toBe(false);
});

test("Three members cluster: two on top, one centred below", () => {
  const [a, b, c] = collageLayout(3) as [CollageSlot, CollageSlot, CollageSlot];
  expect(a.top).toBe(b.top);
  expect(a.left).toBeLessThan(b.left);
  expect(c.top).toBeGreaterThan(a.top);
  expect(c.left + c.size / 2).toBeCloseTo(0.5, 5);
});

test("Four members form an overlapping 2 by 2", () => {
  const [a, b, c, d] = collageLayout(4) as [CollageSlot, CollageSlot, CollageSlot, CollageSlot];
  expect(a.top).toBe(b.top);
  expect(c.top).toBe(d.top);
  expect(a.left).toBe(c.left);
  expect(b.left).toBe(d.left);
  expect(a.left + a.size).toBeGreaterThan(b.left);
  expect(a.top + a.size).toBeGreaterThan(c.top);
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

test("Every slot stays inside the circle's frame", () => {
  for (const count of [1, 2, 3, 4, 5]) {
    for (const slot of collageLayout(count)) {
      const radius = slot.size / 2;
      const dx = slot.left + radius - 0.5;
      const dy = slot.top + radius - 0.5;
      expect(Math.hypot(dx, dy) + radius).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  }
});

test("Initials keep a readable floor at the small frame", () => {
  for (const count of [1, 2, 3, 4, 5]) {
    for (const slot of collageLayout(count)) {
      expect(slot.css.fontSize.startsWith("max(0.625rem,")).toBe(true);
    }
  }
});
