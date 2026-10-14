import { expect, test } from "bun:test";

import { clampPageLimit } from "#src/server/db/page-limit.server";

test("a page size inside the range is kept", () => {
  expect(clampPageLimit(1, 50)).toBe(1);
  expect(clampPageLimit(20, 50)).toBe(20);
  expect(clampPageLimit(50, 50)).toBe(50);
});

test("a page size outside the range becomes the nearest one inside it", () => {
  expect(clampPageLimit(0, 50)).toBe(1);
  expect(clampPageLimit(-5, 50)).toBe(1);
  expect(clampPageLimit(51, 50)).toBe(50);
  expect(clampPageLimit(Number.POSITIVE_INFINITY, 100)).toBe(100);
});

test("NaN is left for input validation to refuse, as Math.min/Math.max leave it", () => {
  expect(clampPageLimit(Number.NaN, 50)).toBeNaN();
});
