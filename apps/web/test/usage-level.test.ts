import { expect, test } from "bun:test";

import { usageLevel } from "#src/features/computers/usage-level";

test("more than 20% left is plenty, 20% or less is low, nothing left is empty", () => {
  expect(usageLevel(0)).toBe("plenty");
  expect(usageLevel(79.99)).toBe("plenty");
  expect(usageLevel(80)).toBe("low");
  expect(usageLevel(99.99)).toBe("low");
  expect(usageLevel(100)).toBe("empty");
  expect(usageLevel(120)).toBe("empty");
});

test("a window the provider reports at its limit is empty whatever its percent says", () => {
  expect(usageLevel(12, true)).toBe("empty");
  expect(usageLevel(85, true)).toBe("empty");
});
