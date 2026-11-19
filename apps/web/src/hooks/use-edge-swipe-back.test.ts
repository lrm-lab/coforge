import { describe, expect, it } from "bun:test";
import { shouldCompleteSwipeBack } from "./use-edge-swipe-back";

describe("shouldCompleteSwipeBack", () => {
  it("completes when dragged past the distance threshold", () => {
    expect(shouldCompleteSwipeBack(0.35, 0)).toBe(true);
    expect(shouldCompleteSwipeBack(0.2, 0.1)).toBe(false);
  });

  it("completes on fast release velocity even before the distance threshold", () => {
    expect(shouldCompleteSwipeBack(0.12, 0.6)).toBe(true);
  });
});
