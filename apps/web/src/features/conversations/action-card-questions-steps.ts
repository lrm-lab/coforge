/**
 * The steps of a questions card being answered, one question at a time (task #515, as Claude Code
 * asks several questions): steps `0` to `total - 1` are the questions, step `total` the review of
 * every answer, where the card is sent.
 */

/** The step `delta` away, kept between the first question and the review. */
export function moveStep(step: number, delta: number, total: number): number {
  return Math.min(Math.max(step + delta, 0), total);
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

/**
 * Where the question under a sideways-moving finger sits, `dx` from where the touch began, on a
 * card `width` wide (task #91): with a question on that side it is the finger, one to one, as far
 * as a whole page; towards a side with none it gives less the further it is pulled, the way a
 * scroll view resists past its end (Apple's rubber band, its constant 0.55), never past a page.
 */
export function trackOffset(
  dx: number,
  width: number,
  hasNext: boolean,
  hasPrevious: boolean,
): number {
  const open = dx < 0 ? hasNext : hasPrevious;
  const distance = Math.abs(dx);
  const reach = open
    ? Math.min(distance, width)
    : (1 - 1 / ((distance * RUBBER_BAND) / width + 1)) * width;
  return Math.sign(dx) * reach;
}
const RUBBER_BAND = 0.55;

/** A flick this fast turns the question however short it was, in CSS pixels per millisecond. */
const FLICK_SPEED = 0.3;
/** Let go past this share of a page, it turns, however slowly it was moving. */
const TURN_SHARE = 0.35;

/**
 * Which way a question let go at `offset`, moving at `velocity` (px/ms, negative leftward), turns:
 * on (`1`) once dragged far enough left or flicked left, back (`-1`) the same rightward, else none
 * (`0`), so it snaps back. A finger that ends flicking the other way takes it back however far it
 * was dragged; with no question on that side nothing turns.
 */
export function releaseTurn(
  offset: number,
  velocity: number,
  width: number,
  hasNext: boolean,
  hasPrevious: boolean,
): -1 | 0 | 1 {
  const far = Math.abs(offset) >= width * TURN_SHARE;
  if (hasNext && offset < 0 && velocity < FLICK_SPEED / 3 && (far || velocity <= -FLICK_SPEED))
    return 1;
  if (hasPrevious && offset > 0 && velocity > -FLICK_SPEED / 3 && (far || velocity >= FLICK_SPEED))
    return -1;
  return 0;
}

/** The curve a question lands on: steep at first, settling gently (Vaul's iOS sheet curve). */
export const SETTLE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** That curve's slope where it starts (0.72 / 0.32): how much faster than average it moves then. */
const SETTLE_START_SLOPE = 2.25;

/**
 * How long a question let go takes to land `distance` px away, so that it leaves at the speed the
 * finger let go of it (`velocity`, px/ms): `SETTLE_EASE` starts at `SETTLE_START_SLOPE` times its
 * average speed. A flick lands fast, a slow drag gently; kept between 160ms and 320ms, a page being
 * small and close at hand (the short end of a sheet's timings).
 */
export function settleMs(distance: number, velocity: number): number {
  const speed = Math.max(Math.abs(velocity), 0.5);
  return Math.round(Math.min(Math.max((distance * SETTLE_START_SLOPE) / speed, 160), 320));
}
