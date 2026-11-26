import { describe, expect, test } from "bun:test";

import {
  MAX_ANIMATED_LEAVES,
  mergeLeavingItems,
  reconcileLeavingItems,
  type LeavingEntry,
} from "./use-leaving-items";

type Item = { id: string; label: string };

const byId = (item: Item) => item.id;

describe("reconcileLeavingItems", () => {
  test("keeps a removed item in its previous slot as leaving", () => {
    const previous: Item[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ];
    const next: Item[] = [
      { id: "a", label: "A" },
      { id: "c", label: "C" },
    ];

    const result = reconcileLeavingItems(previous, next, [], byId);

    expect(result.addedKeys).toEqual(["b"]);
    expect(mergeLeavingItems(next, result.leaving, byId)).toEqual([
      { item: { id: "a", label: "A" }, leaving: false },
      { item: { id: "b", label: "B" }, leaving: true },
      { item: { id: "c", label: "C" }, leaving: false },
    ]);
  });

  test("removes a leaving entry immediately when the same key is restored by undo", () => {
    const previous: Item[] = [{ id: "a", label: "A" }];
    const restored: Item[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const activeLeaving: LeavingEntry<Item>[] = [
      { key: "b", item: { id: "b", label: "B" }, index: 1 },
    ];

    const result = reconcileLeavingItems(previous, restored, activeLeaving, byId);

    expect(result.addedKeys).toEqual([]);
    expect(result.leaving).toEqual([]);
    expect(mergeLeavingItems(restored, result.leaving, byId)).toEqual([
      { item: { id: "a", label: "A" }, leaving: false },
      { item: { id: "b", label: "B" }, leaving: false },
    ]);
  });

  test("skips exit animation when more than MAX_ANIMATED_LEAVES items are removed at once", () => {
    const previous: Item[] = Array.from({ length: MAX_ANIMATED_LEAVES + 2 }, (_, index) => ({
      id: `item-${index}`,
      label: `Item ${index}`,
    }));
    const next: Item[] = [previous[0]!];

    const result = reconcileLeavingItems(previous, next, [], byId);

    expect(result.addedKeys).toEqual([]);
    expect(result.leaving).toEqual([]);
  });

  test("preserves the activeLeaving reference when leaving entries do not change", () => {
    const items: Item[] = [{ id: "a", label: "A" }];
    const emptyLeaving: LeavingEntry<Item>[] = [];
    const emptyResult = reconcileLeavingItems(items, [...items], emptyLeaving, byId);
    expect(emptyResult.leaving).toBe(emptyLeaving);
    expect(emptyResult.addedKeys).toEqual([]);

    const activeLeaving: LeavingEntry<Item>[] = [
      { key: "b", item: { id: "b", label: "B" }, index: 1 },
    ];
    const unchangedResult = reconcileLeavingItems(items, [...items], activeLeaving, byId);
    expect(unchangedResult.leaving).toBe(activeLeaving);
    expect(unchangedResult.addedKeys).toEqual([]);
  });

  test("never produces duplicate rows when merging leaving items with active items", () => {
    const items: Item[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const staleLeaving: LeavingEntry<Item>[] = [
      { key: "b", item: { id: "b", label: "Old B" }, index: 1 },
      { key: "c", item: { id: "c", label: "C" }, index: 5 },
    ];

    expect(mergeLeavingItems(items, staleLeaving, byId)).toEqual([
      { item: { id: "a", label: "A" }, leaving: false },
      { item: { id: "b", label: "B" }, leaving: false },
      { item: { id: "c", label: "C" }, leaving: true },
    ]);
  });
});
