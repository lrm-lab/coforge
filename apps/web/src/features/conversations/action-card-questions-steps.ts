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
