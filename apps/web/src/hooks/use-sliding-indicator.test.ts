import { describe, expect, it } from "bun:test";
import { computeStretchKeyframes } from "./use-sliding-indicator";

describe("computeStretchKeyframes", () => {
  it("stretches horizontally and squashes vertically at mid-flight for pill indicators", () => {
    const frames = computeStretchKeyframes(
      { left: 0, top: 2, width: 80, height: 32 },
      { left: 100, top: 2, width: 100, height: 32 },
      "pill",
    );
    expect(frames).toHaveLength(3);
    expect(frames[0]?.transform).toBe("translate3d(0px, 2px, 0) scale(0.8, 1)");
    expect(String(frames[1]?.transform)).toContain("scale(");
    expect(String(frames[1]?.transform)).toContain(", 0.86)");
    expect(frames[2]?.transform).toBe("translate3d(100px, 2px, 0) scale(1, 1)");
  });

  it("keeps underline indicators on y=0 without vertical squash", () => {
    const frames = computeStretchKeyframes(
      { left: 120, top: 0, width: 60, height: 2 },
      { left: 20, top: 0, width: 80, height: 2 },
      "underline",
    );
    expect(frames[0]?.transform).toBe("translate3d(120px, 0px, 0) scale(0.75, 1)");
    expect(String(frames[1]?.transform)).toContain("translate3d(20px, 0px, 0)");
    expect(String(frames[1]?.transform)).toContain(", 1)");
    expect(frames[2]?.transform).toBe("translate3d(20px, 0px, 0) scale(1, 1)");
  });
});
