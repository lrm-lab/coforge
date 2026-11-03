import { expect, test } from "bun:test";
import { attachStderrExcerpt } from "#src/stderr-excerpt";

test("an empty stderr head leaves the error unchanged", () => {
  const error = new Error("Maximum call stack size exceeded");
  attachStderrExcerpt({ stderrExcerpt: () => "" }, error);
  expect(error.message).toBe("Maximum call stack size exceeded");
});

test("a stderr head is appended to the same error", () => {
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
