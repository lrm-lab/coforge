import { expect, test } from "bun:test";
import {
  formatZoomPercent,
  resolveSwipeStep,
} from "#src/features/conversations/use-lightbox-dismiss-swipe";

test("formatZoomPercent rounds scale to percentage string", () => {
  expect(formatZoomPercent(1)).toBe("100%");
  expect(formatZoomPercent(1.254)).toBe("125%");
  expect(formatZoomPercent(2.5)).toBe("250%");
});

test("resolveSwipeStep handles distance, velocity flicks, and gallery edge guards", () => {
  expect(resolveSwipeStep(-80, -0.1, 1, 5)).toBe(1);
  expect(resolveSwipeStep(80, 0.1, 1, 5)).toBe(-1);
  expect(resolveSwipeStep(-24, -0.6, 1, 5)).toBe(1);
  expect(resolveSwipeStep(24, 0.6, 1, 5)).toBe(-1);
  expect(resolveSwipeStep(100, 0.8, 0, 5)).toBe(0);
  expect(resolveSwipeStep(-100, -0.8, 4, 5)).toBe(0);
  expect(resolveSwipeStep(-100, -0.8, 0, 1)).toBe(0);
});
