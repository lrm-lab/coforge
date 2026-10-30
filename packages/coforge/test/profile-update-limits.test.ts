import { expect, test } from "bun:test";
import { parseArgs } from "../index";

const update =
  (...args: string[]) =>
  () =>
    parseArgs(["profile", "update", ...args]);

test("profile update with nothing to change names the options and the usage", () => {
  expect(update()).toThrow(
    "Provide at least one of --display-name or --description\nUsage: coforge profile update",
  );
});

test("a display name is trimmed, then must be 1 to 80 characters", () => {
  expect(update("--display-name", "   ")).toThrow("--display-name must not be empty");
  expect(update("--display-name", "x".repeat(81))).toThrow(
    "--display-name must be at most 80 characters",
  );
  expect(update("--display-name", ` ${"x".repeat(80)} `)).not.toThrow();
});

test("a description is trimmed, may be empty to clear it, and is at most 3000 characters", () => {
  expect(update("--description", "y".repeat(3001))).toThrow(
    "--description must be at most 3000 characters",
  );
  expect(update("--description", "y".repeat(3000))).not.toThrow();
  expect(update("--description", "")).not.toThrow();
  expect(update("--description", ` ${"y".repeat(3000)} `)).not.toThrow();
});

test("an unknown option still gets the usage line", () => {
  expect(update("--avatar-file", "a.png")).toThrow("Usage: coforge profile update");
});
