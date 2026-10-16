/**
 * The single unit every Activity length cap is expressed in: Unicode code
 * points. `String.length`/`String.slice` count UTF-16 code units, so they
 * count an emoji (or any other astral character) as two and can split a
 * surrogate pair in half, leaving a lone surrogate on the wire. Scanning
 * UTF-16 code units and stepping two units across each valid surrogate pair
 * keeps every cap below an exact, pair-safe budget without allocating an
 * array of single-character strings.
 */

/**
 * UTF-16 code-unit index immediately after the first `max` Unicode code
 * points of `value`, or `value.length` when `value` has at most `max` code
 * points.
 */
function codeUnitOffsetAfterCodePoints(value: string, max: number): number {
  const unitLength = value.length;
  let offset = 0;
  let remaining = max;
  while (offset < unitLength && remaining > 0) {
    offset +=
      (value.charCodeAt(offset) & 0xfc00) === 0xd800 &&
      offset + 1 < unitLength &&
      (value.charCodeAt(offset + 1) & 0xfc00) === 0xdc00
        ? 2
        : 1;
    remaining--;
  }
  return offset;
}

/** Number of Unicode code points in `value`. */
export function codePointLength(value: string): number {
  const unitLength = value.length;
  let count = unitLength;
  for (let index = 0; index + 1 < unitLength; index++) {
    if (
      (value.charCodeAt(index) & 0xfc00) === 0xd800 &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      count--;
      index++;
    }
  }
  return count;
}

/**
 * First `max` Unicode code points of `value`; `value` itself when already
 * within budget. Never splits a surrogate pair.
 */
export function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max || Number.isNaN(max)) return value;
  if (max < 0) return [...value].slice(0, max).join("");
  const end = codeUnitOffsetAfterCodePoints(value, Math.floor(max));
  return end < value.length ? value.slice(0, end) : value;
}

/**
 * `value` cut to its first `max` Unicode code points with `…` appended, or `value` itself
 * when already within budget. A string whose UTF-16 length is within budget is returned
 * without scanning its code units.
 */
export function truncateCodePointsWithEllipsis(value: string, max: number): string {
  if (value.length <= max || Number.isNaN(max)) return value;
  if (max < 0) return `${[...value].slice(0, max).join("")}…`;
  const end = codeUnitOffsetAfterCodePoints(value, Math.floor(max));
  return end < value.length ? `${value.slice(0, end)}…` : value;
}
