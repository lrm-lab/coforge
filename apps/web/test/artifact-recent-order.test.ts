import { expect, test } from "bun:test";
import {
  orderRecentArtifacts,
  readRecentArtifactIds,
  recordRecentArtifactOpen,
} from "#src/features/artifacts/artifact-recent-order";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

test("recordRecentArtifactOpen stores deduplicated MRU ids per conversation", () => {
  const storage = memoryStorage();
  recordRecentArtifactOpen("conv-1", "a", storage);
  recordRecentArtifactOpen("conv-1", "b", storage);
  recordRecentArtifactOpen("conv-1", "a", storage);
  recordRecentArtifactOpen("conv-2", "c", storage);

  expect(readRecentArtifactIds("conv-1", storage)).toEqual(["a", "b"]);
  expect(readRecentArtifactIds("conv-2", storage)).toEqual(["c"]);
});

test("recordRecentArtifactOpen ignores storage failures and corrupt JSON", () => {
  const broken = {
    getItem: () => "{not-json",
    setItem: () => {
      throw new Error("quota exceeded");
    },
  } as unknown as Storage;

  expect(readRecentArtifactIds("conv-1", broken)).toEqual([]);
  expect(() => recordRecentArtifactOpen("conv-1", "a", broken)).not.toThrow();
});

test("orderRecentArtifacts places MRU opens first, then latest updated, capped at limit", () => {
  const items = [
    { id: "old", updatedAt: "2026-11-01T00:00:00Z" },
    { id: "mid", updatedAt: "2026-11-05T00:00:00Z" },
    { id: "new", updatedAt: "2026-11-10T00:00:00Z" },
    { id: "other", updatedAt: "2026-11-08T00:00:00Z" },
  ];

  const ordered = orderRecentArtifacts(items, ["old", "deleted-id", "mid"], 3);
  expect(ordered.map((item) => item.id)).toEqual(["old", "mid", "new"]);
});
