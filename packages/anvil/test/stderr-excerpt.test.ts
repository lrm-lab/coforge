import { expect, test } from "bun:test";
import { attachStderrExcerpt, newestLinesWithin } from "#src/stderr-excerpt";

test("a tail within budget is kept whole, in order", () => {
  expect(newestLinesWithin(["first", "second"], 100)).toBe("first\nsecond");
});

test("a tail over budget keeps the newest lines, not the oldest", () => {
  // The visible error is cut from its start, so a head-first choice would drop the newest line —
  // the one that says what the process was doing when it stopped (task #683).
  expect(
    newestLinesWithin(["oldest padding line", "middle padding", "watcher subscribe"], 20),
  ).toBe("watcher subscribe");
});

test("a single line longer than the budget is still reported", () => {
  expect(newestLinesWithin(["x".repeat(40)], 10)).toBe("x".repeat(10));
});

test("no lines stay an empty excerpt", () => {
  expect(newestLinesWithin([], 10)).toBe("");
});

test("an empty stderr tail leaves the error unchanged", () => {
  const error = new Error("Maximum call stack size exceeded");
  attachStderrExcerpt({ stderrExcerpt: () => "" }, error);
  expect(error.message).toBe("Maximum call stack size exceeded");
});

test("a stderr tail is appended to the same error", () => {
  const error = new Error("Maximum call stack size exceeded");
  attachStderrExcerpt({ stderrExcerpt: () => "Usage limit reached" }, error);
  expect(error.message).toBe("Maximum call stack size exceeded\nUsage limit reached");
});

test("a head already present on the error is not appended twice", () => {
  const error = new Error("Usage limit reached");
  attachStderrExcerpt({ stderrExcerpt: () => "Usage limit reached" }, error);
  expect(error.message).toBe("Usage limit reached");
});

test("a frozen error message stays unchanged", () => {
  const error = new Error("session open failed");
  Object.defineProperty(error, "message", { value: "session open failed", writable: false });
  attachStderrExcerpt({ stderrExcerpt: () => "Usage limit reached" }, error);
  expect(error.message).toBe("session open failed");
});

test("a value that is not an error is left alone", () => {
  const error = "session open failed";
  attachStderrExcerpt({ stderrExcerpt: () => "Usage limit reached" }, error);
  expect(error).toBe("session open failed");
});
