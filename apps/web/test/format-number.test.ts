import { afterEach, expect, test } from "bun:test";

import { formatNumber } from "#src/lib/format-number";
import { overwriteGetLocale } from "#src/paraglide/runtime";

afterEach(() => overwriteGetLocale(() => "en"));

test("formats counts using the active locale with cached Intl.NumberFormat instances", () => {
  overwriteGetLocale(() => "en");
  expect(formatNumber(1284)).toBe("1,284");
  expect(formatNumber(42)).toBe("42");

  overwriteGetLocale(() => "zh-CN");
  expect(formatNumber(1284)).toBe("1,284");
});
