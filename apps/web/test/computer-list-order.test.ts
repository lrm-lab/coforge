import { describe, expect, test } from "bun:test";

import { orderComputersOwnFirst } from "#src/features/computers/computer-list-order";

describe("orderComputersOwnFirst", () => {
  test("places the current user's computers before others while preserving order within each group", () => {
    const input = [
      { id: "other-1", ownedByCurrentUser: false },
      { id: "mine-1", ownedByCurrentUser: true },
      { id: "other-2", ownedByCurrentUser: false },
      { id: "mine-2", ownedByCurrentUser: true },
    ];

    expect(orderComputersOwnFirst(input).map((computer) => computer.id)).toEqual([
      "mine-1",
      "mine-2",
      "other-1",
      "other-2",
    ]);
  });

  test("preserves input order when all computers have the same ownership", () => {
    const allMine = [
      { id: "a", ownedByCurrentUser: true },
      { id: "b", ownedByCurrentUser: true },
    ];
    const allOthers = [
      { id: "c", ownedByCurrentUser: false },
      { id: "d", ownedByCurrentUser: false },
    ];

    expect(orderComputersOwnFirst(allMine).map((computer) => computer.id)).toEqual(["a", "b"]);
    expect(orderComputersOwnFirst(allOthers).map((computer) => computer.id)).toEqual(["c", "d"]);
  });

  test("does not mutate the original array", () => {
    const input = [
      { id: "other", ownedByCurrentUser: false },
      { id: "mine", ownedByCurrentUser: true },
    ];

    const result = orderComputersOwnFirst(input);

    expect(input.map((computer) => computer.id)).toEqual(["other", "mine"]);
    expect(result.map((computer) => computer.id)).toEqual(["mine", "other"]);
  });
});
