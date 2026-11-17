import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkRepoHooksPath } from "./hooks-path";
import { useTestRepo } from "./test-repo";

const repo = useTestRepo();

test("fails with fix command when core.hooksPath is unset in a repo with .githooks", () => {
  mkdirSync(join(repo.dir, ".githooks"));
  repo.ok("config", "--unset", "core.hooksPath");

  const result = checkRepoHooksPath(repo.dir);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error).toContain("git config --local core.hooksPath .githooks");
});

test("fails with fix command when core.hooksPath points to another directory", () => {
  mkdirSync(join(repo.dir, ".githooks"));
  mkdirSync(join(repo.dir, "other-hooks"));
  repo.ok("config", "core.hooksPath", "other-hooks");

  const result = checkRepoHooksPath(repo.dir);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error).toContain("core.hooksPath is");
  expect(result.error).toContain("git config --local core.hooksPath .githooks");
});

test("passes when core.hooksPath points to the worktree's .githooks", () => {
  mkdirSync(join(repo.dir, ".githooks"));
  repo.ok("config", "core.hooksPath", ".githooks");

  expect(checkRepoHooksPath(repo.dir)).toEqual({ ok: true });
});
