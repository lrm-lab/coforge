import { describe, expect, test } from "bun:test";
import { computeFlipTransform } from "./shared-element-rect";

describe("computeFlipTransform", () => {
  test("computes center-to-center translate and box scale", () => {
    const transform = computeFlipTransform(
      { top: 100, left: 50, width: 100, height: 50 },
      { top: 0, left: 0, width: 400, height: 200 },
      "box",
    );
    expect(transform).toBe("translate3d(-100px, 25px, 0) scale(0.25, 0.25)");
  });

  test("preserves aspect ratio in uniform mode using minimum scale", () => {
    const transform = computeFlipTransform(
      { top: 0, left: 0, width: 200, height: 100 },
      { top: 0, left: 0, width: 400, height: 400 },
      "uniform",
    );
    expect(transform).toBe("translate3d(-100px, -150px, 0) scale(0.25)");
  });

  test("returns null for degenerate zero-size boxes", () => {
    expect(
      computeFlipTransform(
        { top: 0, left: 0, width: 0, height: 50 },
        { top: 0, left: 0, width: 100, height: 50 },
      ),
    ).toBeNull();
  });
});
