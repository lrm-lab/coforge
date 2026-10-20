import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTestRepo } from "../git-hooks/test-repo";

// The local gate `bun run check` runs first: the pre-commit hook must be installed, and the commits
// not yet on origin/main must pass the hard rules CI applies. `CI` is set in every run, because a
// CI host's value would otherwise decide the outcome.
const gate = join(import.meta.dir, "local-gate.ts");
const repo = useTestRepo();
const local = { CI: "false" };

const runGate = (env: Record<string, string> = local) => repo.run([process.execPath, gate], env);

/** A bare `origin` holding HEAD as `main`, fetched so that origin/main resolves. */
function withOrigin(): string {
  const remote = `${repo.home}/origin.git`;
  repo.ok("init", "-q", "--bare", remote);
  repo.ok("remote", "add", "origin", remote);
  repo.ok("push", "-q", "-u", "origin", "HEAD:main");
  return remote;
}

function installed() {
  repo.ok("config", "core.hooksPath", ".githooks");
}

test("an unset hooks path fails with the command that installs the hook", () => {
  repo.ok("config", "--unset", "core.hooksPath");
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();

  const result = runGate();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "pre-commit hook not installed: run `bun install` (sets core.hooksPath=.githooks)",
  );
});

test("an installed hook and a clean range pass", () => {
  installed();
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.seed({ "docs/a.md": "[readme](../README.md)\n" });

  expect(runGate()).toMatchObject({ exitCode: 0, stderr: "" });
});

test("a commit not on origin/main that breaks a rule fails, naming the base and a fetch", () => {
  installed();
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  const base = repo.head();
  repo.seed({ "big.ts": "x".repeat(20_001) });

  const result = runGate();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("big.ts: 5,001 tokens, new file over the limit");
  expect(result.stderr).toContain(base);
  expect(result.stderr).toContain("git fetch origin");
});

test("a stale origin/main judges from its old commit until it is fetched", () => {
  installed();
  repo.seed({ "README.md": "# Repo\n" });
  const remote = withOrigin();
  const stale = repo.head();
  // Someone else's commit reaches main, and this clone builds on it without fetching origin.
  repo.seed({ "theirs.ts": "x".repeat(20_001) });
  repo.ok("push", "-q", remote, "HEAD:main");
  repo.seed({ "mine.md": "# Mine\n" });

  const result = runGate();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(stale);
  expect(result.stderr).toContain("git fetch origin");

  repo.ok("fetch", "-q", "origin");
  expect(runGate()).toMatchObject({ exitCode: 0, stderr: "" });
});

test("CI=true skips the gate: the Plan checks job runs the hard rules", () => {
  repo.ok("config", "--unset", "core.hooksPath");
  repo.seed({ "big.ts": "x".repeat(20_001) });

  expect(runGate({ CI: "true" }).exitCode).toBe(0);
});

test("with no origin remote, or no origin/main, the range part is skipped in one line", () => {
  installed();
  repo.seed({ "big.ts": "x".repeat(20_001) });

  const noRemote = runGate();
  expect(noRemote.exitCode).toBe(0);
  expect(noRemote.stdout.trim().split("\n")).toHaveLength(1);
  expect(noRemote.stdout).toContain("no `origin` remote");

  repo.ok("remote", "add", "origin", `${repo.home}/nowhere.git`);
  const unfetched = runGate();
  expect(unfetched.exitCode).toBe(0);
  expect(unfetched.stdout.trim().split("\n")).toHaveLength(1);
  expect(unfetched.stdout).toContain("git fetch origin");
});

test("a custom hooks path passes only when its pre-commit runs .githooks/pre-commit", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  mkdirSync(join(repo.dir, "my-hooks"));
  repo.ok("config", "core.hooksPath", "my-hooks");
  writeFileSync(join(repo.dir, "my-hooks/pre-commit"), "#!/bin/sh\necho mine\n");

  const result = runGate();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('core.hooksPath is "my-hooks"');
  expect(result.stderr).toContain(".githooks/pre-commit");

  writeFileSync(join(repo.dir, "my-hooks/pre-commit"), "#!/bin/sh\nexec .githooks/pre-commit\n");
  expect(runGate()).toMatchObject({ exitCode: 0, stderr: "" });
});

test("outside a git work tree the gate does nothing", () => {
  const outside = join(repo.home, "tarball");
  mkdirSync(outside);

  expect(repo.run([process.execPath, gate], local, outside)).toMatchObject({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});
