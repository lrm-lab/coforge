import { expect, test } from "bun:test";

import {
  moveStep,
  releaseTurn,
  settleMs,
  swipeAxis,
  trackOffset,
} from "#src/features/conversations/action-card-questions-steps";

// Four questions: steps 0–3, the last one 3.
test("a questions card's steps run from the first question to the last, no further (task #515)", () => {
  expect(moveStep(0, 1, 3)).toBe(1);
  expect(moveStep(2, 1, 3)).toBe(3);
  expect(moveStep(3, 1, 3)).toBe(3);
  expect(moveStep(0, -1, 3)).toBe(0);
  expect(moveStep(3, -1, 3)).toBe(2);
});

test("a touch is a swipe or a scroll once it has moved far enough to tell (task #560)", () => {
  expect(swipeAxis(-4, 2)).toBeUndefined();
  expect(swipeAxis(-12, 3)).toBe("x");
  expect(swipeAxis(10, 9)).toBe("y");
  expect(swipeAxis(2, -14)).toBe("y");
});

test("the question under a finger is the finger, and resists past an end (task #91)", () => {
  // A question each side: one to one, both ways, up to a whole page.
  expect(trackOffset(-60, 350, true, true)).toBe(-60);
  expect(trackOffset(60, 350, true, true)).toBe(60);
  expect(trackOffset(-500, 350, true, true)).toBe(-350);
  // The first pulled back, the last pushed on: it gives, less and less, never a page.
  const back = trackOffset(80, 350, true, false);
  expect(back).toBeGreaterThan(30);
  expect(back).toBeLessThan(45);
  expect(trackOffset(-80, 350, false, true)).toBe(-back);
  expect(trackOffset(5000, 350, true, false)).toBeLessThan(350);
});

test("let go, a question turns on distance or on a flick, else snaps back (task #91)", () => {
  // Far enough, slowly: it turns; not far, slowly: back.
  expect(releaseTurn(-150, -0.05, 350, true, true)).toBe(1);
  expect(releaseTurn(150, 0.05, 350, true, true)).toBe(-1);
  expect(releaseTurn(-60, -0.05, 350, true, true)).toBe(0);
  // A short, fast flick turns.
  expect(releaseTurn(-40, -0.6, 350, true, true)).toBe(1);
  expect(releaseTurn(40, 0.6, 350, true, true)).toBe(-1);
  // A finger that flicks back takes it back, however far it was dragged.
  expect(releaseTurn(-200, 0.5, 350, true, true)).toBe(0);
  // No question on that side: nothing turns.
  expect(releaseTurn(-200, -0.8, 350, false, true)).toBe(0);
  expect(releaseTurn(200, 0.8, 350, true, false)).toBe(0);
});

test("a question lands at the speed it was let go, within 160–320ms (task #91)", () => {
  // A fast flick over a short way lands fast; a slow drag takes the longest.
  expect(settleMs(200, -2)).toBeLessThan(settleMs(200, -1));
  expect(settleMs(300, -10)).toBe(160);
  expect(settleMs(300, 0)).toBe(320);
  expect(settleMs(20, 0)).toBe(160);
});
