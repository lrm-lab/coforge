/** A source of numbers in [0, 1): `Math.random` in the browser, a fixed one in a test. */
export type Random = () => number;

/** A number from `low` up to `high`. */
export const between = (low: number, high: number, random: Random) => low + (high - low) * random();
