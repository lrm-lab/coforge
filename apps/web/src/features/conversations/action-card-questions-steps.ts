/**
 * The steps of a questions card being answered, one question at a time (task #515, as Claude Code
 * asks several questions): steps `0` to `total - 1` are the questions, step `total` the review of
 * every answer, where the card is sent.
 */

/** The step `delta` away, kept between the first question and the review. */
export function moveStep(step: number, delta: number, total: number): number {
  return Math.min(Math.max(step + delta, 0), total);
}

/** How far a swipe sideways is taken as meant, in CSS pixels. */
const SWIPE_DISTANCE = 48;

/**
 * The step a touch moving by `dx`, `dy` turns: a leftward swipe on (`1`), a rightward one back
 * (`-1`); one too short, or more vertical than sideways (a scroll), none (`0`).
 */
export function swipeDelta(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** How far a touch moves before it is read as a swipe sideways or a scroll, in CSS pixels. */
const SWIPE_SLOP = 8;

/**
 * Which way a touch that has moved by `dx`, `dy` is going: `"x"` a swipe across the questions,
 * `"y"` a scroll of the conversation, `undefined` not yet far enough to tell.
 */
export function swipeAxis(dx: number, dy: number): "x" | "y" | undefined {
  if (Math.abs(dx) >= SWIPE_SLOP && Math.abs(dx) >= Math.abs(dy) * 1.5) return "x";
  if (Math.abs(dy) >= SWIPE_SLOP) return "y";
  return undefined;
}

/** The farthest the page under a finger follows it before it lets go, in CSS pixels. */
const DRAG_REACH = 96;

/**
 * Where the question under a sideways-moving finger sits, `dx` from where the touch began: it
 * follows the finger at half its speed, up to `DRAG_REACH`, so the next question shows from the
 * edge before it comes; towards a side with no question it gives a quarter as far, the way a
 * scroll view resists past its end.
 */
export function dragOffset(dx: number, hasNext: boolean, hasPrevious: boolean): number {
  const open = dx < 0 ? hasNext : hasPrevious;
  const reach = Math.min(Math.abs(dx) * (open ? 0.5 : 0.125), DRAG_REACH);
  return Math.sign(dx) * reach;
}
