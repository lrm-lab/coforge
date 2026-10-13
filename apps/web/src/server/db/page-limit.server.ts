/**
 * A requested page size held between 1 and `max`: a caller asking for 0, a negative number or
 * more than the page allows gets the nearest size that is. `NaN` stays `NaN`, as `Math.min`/
 * `Math.max` leave it, so input validation upstream still owns non-numbers.
 */
export function clampPageLimit(requested: number, max: number): number {
  return Math.min(Math.max(requested, 1), max);
}
