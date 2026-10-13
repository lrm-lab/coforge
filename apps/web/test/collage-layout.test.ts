import { expect, test } from "bun:test";

import { collageLayout } from "#src/features/conversations/collage-layout";

/**
 * The channel avatar is a 6-column by 2-row grid. Each tile is a grid-line span (`[start, end)`),
 * and for every count the tiles must cover all 12 cells exactly once: no empty cell, no overlap.
 */
const GRID_ROWS = 2;
const GRID_COLUMNS = 6;

function cellsOf(tiles: ReturnType<typeof collageLayout>): string[] {
  const cells: string[] = [];
  for (const { row, column } of tiles) {
    for (let r = row[0]; r < row[1]; r++)
      for (let c = column[0]; c < column[1]; c++) cells.push(`${r}:${c}`);
  }
  return cells.sort();
}

function expectFullCover(tiles: ReturnType<typeof collageLayout>) {
  const all: string[] = [];
  for (let r = 1; r <= GRID_ROWS; r++)
    for (let c = 1; c <= GRID_COLUMNS; c++) all.push(`${r}:${c}`);
  expect(cellsOf(tiles)).toEqual(all.sort());
}

test("no members means no tiles", () => {
  expect(collageLayout(0)).toEqual([]);
});

test("one member fills the whole frame with that member's avatar", () => {
  expect(collageLayout(1)).toEqual([{ row: [1, 3], column: [1, 7] }]);
});

test("two members sit side by side, each half the width and the full height", () => {
  expect(collageLayout(2)).toEqual([
    { row: [1, 3], column: [1, 4] },
    { row: [1, 3], column: [4, 7] },
  ]);
});

test("three members: one full-width tile on top, two halves below", () => {
  expect(collageLayout(3)).toEqual([
    { row: [1, 2], column: [1, 7] },
    { row: [2, 3], column: [1, 4] },
    { row: [2, 3], column: [4, 7] },
  ]);
});

test("four members form a 2 by 2 grid", () => {
  expect(collageLayout(4)).toEqual([
    { row: [1, 2], column: [1, 4] },
    { row: [1, 2], column: [4, 7] },
    { row: [2, 3], column: [1, 4] },
    { row: [2, 3], column: [4, 7] },
  ]);
});

test("five members: three thirds on top, two halves below", () => {
  expect(collageLayout(5)).toEqual([
    { row: [1, 2], column: [1, 3] },
    { row: [1, 2], column: [3, 5] },
    { row: [1, 2], column: [5, 7] },
    { row: [2, 3], column: [1, 4] },
    { row: [2, 3], column: [4, 7] },
  ]);
});

test("six members form three over three", () => {
  expect(collageLayout(6)).toEqual([
    { row: [1, 2], column: [1, 3] },
    { row: [1, 2], column: [3, 5] },
    { row: [1, 2], column: [5, 7] },
    { row: [2, 3], column: [1, 3] },
    { row: [2, 3], column: [3, 5] },
    { row: [2, 3], column: [5, 7] },
  ]);
});

test("every count from one to six covers the grid exactly once with one tile per member", () => {
  for (let count = 1; count <= 6; count++) {
    const tiles = collageLayout(count);
    expect(tiles).toHaveLength(count);
    expectFullCover(tiles);
  }
});

test("more than six members clamps to the six-member layout", () => {
  expect(collageLayout(7)).toEqual(collageLayout(6));
  expect(collageLayout(12)).toEqual(collageLayout(6));
});
