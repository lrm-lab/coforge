import { describe, expect, it } from "bun:test";
import { edgeFadeStyle, TAB_BAR_END_FADE_WIDTH } from "./use-scroll-edges";

describe("edgeFadeStyle", () => {
  it("returns undefined when neither edge overflows", () => {
    expect(edgeFadeStyle({ start: false, end: false })).toBeUndefined();
    expect(
      edgeFadeStyle({ start: false, end: false }, { end: TAB_BAR_END_FADE_WIDTH }),
    ).toBeUndefined();
  });

  it("applies a 3.5rem (56px) right-edge fade mask when only the end overflows", () => {
    const mask = "linear-gradient(to right, black, black calc(100% - 3.5rem), transparent)";
    expect(edgeFadeStyle({ start: false, end: true }, { end: TAB_BAR_END_FADE_WIDTH })).toEqual({
      maskImage: mask,
      WebkitMaskImage: mask,
    });
  });

  it("combines the default start fade with a 3.5rem end fade when both edges overflow", () => {
    const mask =
      "linear-gradient(to right, transparent, black 1.25rem, black calc(100% - 3.5rem), transparent)";
    expect(edgeFadeStyle({ start: true, end: true }, { end: TAB_BAR_END_FADE_WIDTH })).toEqual({
      maskImage: mask,
      WebkitMaskImage: mask,
    });
  });

  it("removes the right-edge fade once scrolled to the end", () => {
    const mask = "linear-gradient(to right, transparent, black 1.25rem, black)";
    expect(edgeFadeStyle({ start: true, end: false }, { end: TAB_BAR_END_FADE_WIDTH })).toEqual({
      maskImage: mask,
      WebkitMaskImage: mask,
    });
  });

  it("still accepts a single width string for both edges", () => {
    const mask =
      "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)";
    expect(edgeFadeStyle({ start: true, end: true }, "2rem")).toEqual({
      maskImage: mask,
      WebkitMaskImage: mask,
    });
  });
});
