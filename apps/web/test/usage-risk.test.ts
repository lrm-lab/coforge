import { expect, test } from "bun:test";

import { usageRisk } from "#src/features/computers/usage-risk";

test("a used share under 70% is fine, 70% up to 90% is a warning, 90% and over is an error", () => {
  expect(usageRisk(0)).toBe("success");
  expect(usageRisk(69.99)).toBe("success");
  expect(usageRisk(70)).toBe("warning");
  expect(usageRisk(89.99)).toBe("warning");
  expect(usageRisk(90)).toBe("error");
  expect(usageRisk(100)).toBe("error");
});

test("a window the provider reports at its limit is an error whatever its percent says", () => {
  expect(usageRisk(12, true)).toBe("error");
  expect(usageRisk(75, true)).toBe("error");
});
