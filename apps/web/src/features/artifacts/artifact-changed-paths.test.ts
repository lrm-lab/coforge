import { expect, test } from "bun:test";
import { formatChangedPaths } from "./artifact-changed-paths";

test("returns undefined when no paths changed", () => {
  expect(formatChangedPaths([], 0, 3)).toBeUndefined();
});

test("lists all paths when within maxShown and changedCount", () => {
  expect(formatChangedPaths(["index.html", "app.js"], 2, 3)).toBe("Changed: index.html, app.js");
});

test("truncates to maxShown and shows remaining count", () => {
  expect(formatChangedPaths(["a.ts", "b.ts", "c.ts", "d.ts"], 4, 3)).toBe(
    "Changed: a.ts, b.ts, c.ts and 1 more",
  );
});

test("accounts for server-truncated changedCount beyond returned paths", () => {
  expect(formatChangedPaths(["a.ts", "b.ts", "c.ts", "d.ts"], 12, 3)).toBe(
    "Changed: a.ts, b.ts, c.ts and 9 more",
  );
});
