import { describe, expect, test } from "bun:test";

import { shouldReleaseHeldHeight } from "#src/features/conversations/settle-in-place";

describe("shouldReleaseHeldHeight", () => {
  test("ignores small inline width jitter such as a scrollbar appearing or disappearing", () => {
    expect(shouldReleaseHeldHeight(448, 448)).toBe(false);
    expect(shouldReleaseHeldHeight(448, 433)).toBe(false);
    expect(shouldReleaseHeldHeight(433, 448)).toBe(false);
    expect(shouldReleaseHeldHeight(448, 425)).toBe(false);
  });

  test("releases held height on genuine container width changes", () => {
    expect(shouldReleaseHeldHeight(448, 424)).toBe(true);
    expect(shouldReleaseHeldHeight(448, 360)).toBe(true);
    expect(shouldReleaseHeldHeight(390, 844)).toBe(true);
  });
});
