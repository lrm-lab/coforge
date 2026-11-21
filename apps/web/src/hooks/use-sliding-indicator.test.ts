import { describe, expect, it } from "bun:test";
import {
  SLIDE_SPRING,
  computeSlideSpringTiming,
  computeStretchKeyframes,
} from "./use-sliding-indicator";

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

describe("computeSlideSpringTiming", () => {
  it("uses stiffness 400 and damping 30 as the default spring parameters", () => {
    expect(SLIDE_SPRING).toEqual({ stiffness: 400, damping: 30 });
  });

  it("generates a WAAPI linear() spring curve that overshoots slightly before settling at 1", () => {
    const timing = computeSlideSpringTiming();
    expect(timing.duration).toBeGreaterThan(0);
    expect(timing.easing.startsWith("linear(")).toBe(true);
    expect(timing.easing.endsWith(")")).toBe(true);
    const stops = timing.easing
      .slice("linear(".length, -1)
      .split(",")
      .map((value) => Number.parseFloat(value.trim()));
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(1);
    const peak = Math.max(...stops);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.06);
  });
});
