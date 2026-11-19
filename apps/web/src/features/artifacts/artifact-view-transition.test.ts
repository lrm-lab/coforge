import { afterEach, describe, expect, test } from "bun:test";

import {
  clearArtifactViewTransition,
  getActiveArtifactTransitionId,
  prepareArtifactViewTransition,
  subscribeArtifactTransition,
} from "./artifact-view-transition";

afterEach(() => {
  clearArtifactViewTransition();
});

describe("artifact-view-transition", () => {
  test("tracks active artifact id and notifies subscribers on prepare and clear", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeArtifactTransition(() => {
      seen.push(getActiveArtifactTransitionId());
    });

    prepareArtifactViewTransition("art-1");
    expect(getActiveArtifactTransitionId()).toBe("art-1");

    prepareArtifactViewTransition("art-2");
    expect(getActiveArtifactTransitionId()).toBe("art-2");

    clearArtifactViewTransition();
    expect(getActiveArtifactTransitionId()).toBeNull();

    unsubscribe();
    expect(seen).toEqual(["art-1", "art-2", null]);
  });

  test("clearing when already idle does not emit duplicate notifications", () => {
    let calls = 0;
    const unsubscribe = subscribeArtifactTransition(() => {
      calls += 1;
    });

    clearArtifactViewTransition();
    expect(calls).toBe(0);

    unsubscribe();
  });
});
