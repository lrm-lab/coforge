import { expect, test } from "bun:test";

import { moveStep, swipeDelta } from "#src/features/conversations/action-card-questions-steps";

// Three questions: steps 0–2 are the questions, step 3 the review of every answer.
test("a questions card's steps run from the first question to the review, no further (task #515)", () => {
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
