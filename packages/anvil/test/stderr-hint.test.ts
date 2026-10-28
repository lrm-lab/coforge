import { expect, test } from "bun:test";
import { scrubStderrHint } from "#src/stderr-hint";

test("trims and keeps one bounded line", () => {
  expect(scrubStderrHint("  error: unknown flag  \n")).toBe("error: unknown flag");
  expect(scrubStderrHint("x".repeat(300))).toHaveLength(200);
});

test("redacts token-shaped words and Bearer credentials", () => {
  expect(scrubStderrHint("sk-1234567890abcdef")).toBe("[redacted]");
  expect(scrubStderrHint("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
});
