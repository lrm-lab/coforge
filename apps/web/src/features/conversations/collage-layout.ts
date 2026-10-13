/**
 * Where each member tile of a channel's collage avatar sits. The frame is a 6-column by 2-row grid,
 * and every count fills it exactly: 1 is one tile, 2 are side by side, 3 are a full-width tile over
 * two halves, 4 are a 2 by 2 grid, 5 are three thirds over two halves, 6 are three over three. No
 * members has no collage (`[]`): the row shows the channel's icon instead.
 * `row` and `column` are CSS grid lines, `[start, end)`, starting at 1.
 */
export type CollageTile = { row: readonly [number, number]; column: readonly [number, number] };

export const COLLAGE_MAX_TILES = 6;

const LAYOUTS: readonly (readonly CollageTile[])[] = [
  [],
  [{ row: [1, 3], column: [1, 7] }],
  [
    { row: [1, 3], column: [1, 4] },
    { row: [1, 3], column: [4, 7] },
  ],
  [
    { row: [1, 2], column: [1, 7] },
    { row: [2, 3], column: [1, 4] },
    { row: [2, 3], column: [4, 7] },
  ],
  [
    { row: [1, 2], column: [1, 4] },
    { row: [1, 2], column: [4, 7] },
    { row: [2, 3], column: [1, 4] },
    { row: [2, 3], column: [4, 7] },
  ],
  [
    { row: [1, 2], column: [1, 3] },
    { row: [1, 2], column: [3, 5] },
    { row: [1, 2], column: [5, 7] },
    { row: [2, 3], column: [1, 4] },
    { row: [2, 3], column: [4, 7] },
  ],
  [
    { row: [1, 2], column: [1, 3] },
    { row: [1, 2], column: [3, 5] },
    { row: [1, 2], column: [5, 7] },
    { row: [2, 3], column: [1, 3] },
    { row: [2, 3], column: [3, 5] },
    { row: [2, 3], column: [5, 7] },
  ],
];

/** The tiles for `count` members, in order. Counts above six use the six-member layout. */
export function collageLayout(count: number): readonly CollageTile[] {
  const tiles = Math.max(0, Math.min(COLLAGE_MAX_TILES, Math.floor(count)));
  return LAYOUTS[tiles] ?? [];
}
