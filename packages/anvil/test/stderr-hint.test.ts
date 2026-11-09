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

test("the 200-unit cut never leaves half a surrogate pair in a log field", () => {
  // One BMP character then 101 astral ones: unit 200 falls inside a pair, so the cut backs off
  // one unit rather than emitting half a character.
  const hint = scrubStderrHint(`a${"🙂".repeat(101)}`);
  expect(hint).toHaveLength(199);
  expect(hint.isWellFormed()).toBe(true);
});
