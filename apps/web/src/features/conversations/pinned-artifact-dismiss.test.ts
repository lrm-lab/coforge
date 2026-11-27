import { describe, expect, test } from "bun:test";
import {
  isPinnedArtifactDismissed,
  readPinnedDismissal,
  writePinnedDismissal,
} from "./pinned-artifact-dismiss";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("pinned-artifact-dismiss", () => {
  test("hides the dismissed artifact at the same or older version and resurfaces on newer version or replacement", () => {
    const dismissal = { artifactId: "art-1", version: 6 };
    expect(isPinnedArtifactDismissed({ artifactId: "art-1", version: 6 }, dismissal)).toBe(true);
    expect(isPinnedArtifactDismissed({ artifactId: "art-1", version: 5 }, dismissal)).toBe(true);
    expect(isPinnedArtifactDismissed({ artifactId: "art-1", version: 7 }, dismissal)).toBe(false);
    expect(isPinnedArtifactDismissed({ artifactId: "art-2", version: 1 }, dismissal)).toBe(false);
    expect(isPinnedArtifactDismissed(null, dismissal)).toBe(false);
  });

  test("round-trips and clears dismissal records in storage safely", () => {
    const storage = memoryStorage();
    expect(readPinnedDismissal("conv-1", storage)).toBeNull();

    writePinnedDismissal("conv-1", { artifactId: "art-1", version: 3 }, storage);
    expect(readPinnedDismissal("conv-1", storage)).toEqual({ artifactId: "art-1", version: 3 });

    writePinnedDismissal("conv-1", null, storage);
    expect(readPinnedDismissal("conv-1", storage)).toBeNull();
  });

  test("ignores malformed storage values", () => {
    const storage = memoryStorage();
    storage.setItem("coforge:pinned-artifact-dismissed:v1:conv-2", "{bad json");
    expect(readPinnedDismissal("conv-2", storage)).toBeNull();
  });
});
