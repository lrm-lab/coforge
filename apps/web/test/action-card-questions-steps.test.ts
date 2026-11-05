import { expect, test } from "bun:test";

import {
  dragOffset,
  moveStep,
  swipeAxis,
  swipeDelta,
} from "#src/features/conversations/action-card-questions-steps";

// Four questions: steps 0–3, the last one 3.
test("a questions card's steps run from the first question to the last, no further (task #515)", () => {
  expect(moveStep(0, 1, 3)).toBe(1);
  expect(moveStep(2, 1, 3)).toBe(3);
  expect(moveStep(3, 1, 3)).toBe(3);
  expect(moveStep(0, -1, 3)).toBe(0);
  expect(moveStep(3, -1, 3)).toBe(2);
});

test("a sideways swipe turns a step, a short or mostly vertical one does not (task #515)", () => {
  // Leftward: on to the next step; rightward: back.
  expect(swipeDelta(-80, 10)).toBe(1);
  expect(swipeDelta(80, -10)).toBe(-1);
  // Too short to be meant.
  expect(swipeDelta(-30, 0)).toBe(0);
  // A scroll that drifts sideways.
  expect(swipeDelta(-70, 90)).toBe(0);
});

test("a touch is a swipe or a scroll once it has moved far enough to tell (task #560)", () => {
  expect(swipeAxis(-4, 2)).toBeUndefined();
  expect(swipeAxis(-12, 3)).toBe("x");
  expect(swipeAxis(10, 9)).toBe("y");
  expect(swipeAxis(2, -14)).toBe("y");
});

test("the question under a finger follows it at half speed, a quarter of that past an end (task #560)", () => {
  // A question each side: half the finger's way, both ways.
  expect(dragOffset(-60, true, true)).toBe(-30);
  expect(dragOffset(60, true, true)).toBe(30);
  // No further than its reach.
  expect(dragOffset(-400, true, true)).toBe(-96);
  // The first question pulled back, the last pushed on: it gives a little and no more.
  expect(dragOffset(80, true, false)).toBe(10);
  expect(dragOffset(-80, false, true)).toBe(-10);
});
