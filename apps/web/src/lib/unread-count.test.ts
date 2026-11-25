import { describe, expect, test } from "bun:test";

import { formatCappedCount, formatUnreadCount } from "./unread-count";

describe("formatCappedCount", () => {
  test("hides zero, negative, non-finite and missing counts", () => {
    expect(formatCappedCount(0)).toBeNull();
    expect(formatCappedCount(-1)).toBeNull();
    expect(formatCappedCount(0.4)).toBeNull();
    expect(formatCappedCount(Number.NaN)).toBeNull();
    expect(formatCappedCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatCappedCount(null)).toBeNull();
    expect(formatCappedCount(undefined)).toBeNull();
  });

  test("formats counts 1 through 99 as whole numbers and caps above 99 at 99+", () => {
    expect(formatCappedCount(1)).toBe("1");
    expect(formatCappedCount(9)).toBe("9");
    expect(formatCappedCount(99)).toBe("99");
    expect(formatCappedCount(100)).toBe("99+");
    expect(formatCappedCount(1284)).toBe("99+");
    expect(formatUnreadCount(99)).toBe("99");
    expect(formatUnreadCount(100)).toBe("99+");
  });
});
