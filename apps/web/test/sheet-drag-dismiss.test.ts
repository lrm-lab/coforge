import { expect, test } from "bun:test";
import { dragDismisses } from "#src/components/ui/modal";

// A 300px sheet: a third of it is 100px.
test("a slow pull dismisses only past a third of the sheet", () => {
  expect(dragDismisses(90, 0.1, 300)).toBe(false);
  expect(dragDismisses(110, 0.1, 300)).toBe(true);
});

test("a flick down dismisses however short the pull", () => {
  expect(dragDismisses(20, 0.8, 300)).toBe(true);
});

test("a tap or a jitter on the grabber never dismisses", () => {
  expect(dragDismisses(4, 2, 300)).toBe(false);
  expect(dragDismisses(0, 0, 300)).toBe(false);
});

test("a pull upward never dismisses", () => {
  expect(dragDismisses(-20, -1, 300)).toBe(false);
});
