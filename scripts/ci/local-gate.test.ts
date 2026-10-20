import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
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

test("a custom hooks path is the user's: one warning, no failure, and the range still checked", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.ok("config", "core.hooksPath", "my-hooks");
  const warning =
    "core.hooksPath is my-hooks, not .githooks: the repository's pre-commit and pre-push run only " +
    "if your hooks call them";

  const clean = runGate();
  expect(clean.exitCode).toBe(0);
  expect(clean.stderr.trim()).toBe(`local gate: ${warning}`);

  repo.seed({ "big.ts": "x".repeat(20_001) });
  const violation = runGate();
  expect(violation.exitCode).not.toBe(0);
  expect(violation.stderr).toContain(warning);
  expect(violation.stderr).toContain("big.ts: 5,001 tokens, new file over the limit");
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

test("a hooks path set by -c or GIT_CONFIG_* (an Agent's shim) is not the repository's choice", () => {
  installed();
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  const shim = {
    ...local,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/agent/shims",
  };
  expect(runGate(shim)).toMatchObject({ exitCode: 0, stderr: "" });

  repo.ok("config", "--unset", "core.hooksPath");
  expect(runGate(shim).stderr).toContain("pre-commit hook not installed");
});

test("with several hooks paths, the last one git reads wins", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.ok("config", "--global", "core.hooksPath", "my-hooks");
  installed();
  expect(runGate()).toMatchObject({ exitCode: 0, stderr: "" });

  repo.ok("config", "--global", "core.hooksPath", ".githooks");
  repo.ok("config", "core.hooksPath", "my-hooks");
  expect(runGate().stderr).toContain("core.hooksPath is my-hooks, not .githooks");
});

test("a hooks path naming .githooks another way counts as installed", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  for (const path of [".githooks/", "./.githooks", join(repo.dir, ".githooks")]) {
    repo.ok("config", "core.hooksPath", path);
    expect(runGate(), path).toMatchObject({ exitCode: 0, stderr: "" });
  }
});

test("a custom hooks path whose pre-commit is a directory only warns", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  mkdirSync(join(repo.dir, "my-hooks/pre-commit"), { recursive: true });
  repo.ok("config", "core.hooksPath", "my-hooks");

  const result = runGate();
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("core.hooksPath is my-hooks, not .githooks");
});

test("a branch with no history shared with origin/main is reported in one line, not judged", () => {
  installed();
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.ok("switch", "-q", "--orphan", "other");
  repo.seed({ "big.ts": "x".repeat(20_001) });

  const result = runGate();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("shares no history with origin/main");
});

test("a branch that forked before origin/main advanced is not blamed for main's newer commits", () => {
  installed();
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.ok("switch", "-q", "-c", "feat");
  repo.seed({ "feat.md": "# Feat\n" });
  repo.ok("switch", "-q", "main");
  repo.seed({ "vendor.ts": "x".repeat(20_001) }, { env: { GIT_AUTHOR_NAME: "renovate[bot]" } });
  repo.ok("push", "-q", "--no-verify", "origin", "main");
  repo.ok("switch", "-q", "feat");

  expect(runGate()).toMatchObject({ exitCode: 0, stderr: "" });
});

test("any CI value but false or 0 skips the gate", () => {
  repo.ok("config", "--unset", "core.hooksPath");
  repo.seed({ "README.md": "# Repo\n" });
  for (const value of ["1", "yes"]) expect(runGate({ CI: value }).exitCode, value).toBe(0);
  for (const value of ["0", "false", ""])
    expect(runGate({ CI: value }).stderr, value).toContain("pre-commit hook not installed");
});
