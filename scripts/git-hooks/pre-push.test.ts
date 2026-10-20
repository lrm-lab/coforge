import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { useTestRepo } from "./test-repo";

// Each test pushes from a throwaway repository, whose hooks directory is this repository's real
// `.githooks`, to a bare remote, so the real pre-push hook judges what each push sends.
const repo = useTestRepo();
const BIG = "x".repeat(20_001);

/** A bare `origin`, with `main` pushed to it without the hook. */
function withOrigin() {
  const remote = `${repo.home}/origin.git`;
  repo.ok("init", "-q", "--bare", remote);
  repo.ok("remote", "add", "origin", remote);
  repo.ok("push", "-q", "--no-verify", "-u", "origin", "main");
}

const push = (...args: string[]) => repo.git("push", "-q", ...args);
const remoteHead = (branch: string) => repo.ok("rev-parse", "--verify", "-q", `origin/${branch}`);

test("a clean push passes", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.seed({ "docs/a.md": "[readme](../README.md)\n" });

  expect(push("origin", "main")).toMatchObject({ exitCode: 0, stderr: "" });
  expect(remoteHead("main")).toBe(repo.head());
});

test("a commit that skipped pre-commit blocks the push, naming the ref", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  const before = repo.head();
  repo.seed({ "big.ts": BIG });

  const result = push("origin", "main");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("big.ts: 5,001 tokens, new file over the limit");
  expect(result.stderr).toContain("refs/heads/main");
  expect(remoteHead("main")).toBe(before);
});

test("a new branch is judged from its merge base with origin/main", () => {
  // main already carries an oversized file, pushed without the hook: it is not the branch's.
  repo.seed({ "legacy.ts": BIG });
  withOrigin();
  repo.ok("switch", "-q", "-c", "feat");
  repo.seed({ "feat.md": "# Feat\n" });
  expect(push("-u", "origin", "feat")).toMatchObject({ exitCode: 0, stderr: "" });

  repo.ok("switch", "-q", "-c", "feat-2", "main");
  repo.seed({ "big.ts": BIG });
  const result = push("origin", "feat-2");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("refs/heads/feat-2");
  expect(result.stderr).toContain("big.ts");
  expect(result.stderr).not.toContain("legacy.ts");
});

test("deleting a remote branch passes", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.ok("push", "-q", "--no-verify", "origin", "main:doomed");

  expect(push("origin", "--delete", "doomed")).toMatchObject({ exitCode: 0, stderr: "" });
});

test("git push --no-verify skips the hook", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.seed({ "big.ts": BIG });

  expect(push("--no-verify", "origin", "main").exitCode).toBe(0);
  expect(remoteHead("main")).toBe(repo.head());
});

test("only the pushed commits are checked: a violation already on the remote is not reported", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.seed({ "big.ts": BIG }, { env: { GIT_AUTHOR_NAME: "renovate[bot]" } });
  repo.ok("push", "-q", "--no-verify", "origin", "main");
  repo.seed({ "docs/a.md": "[readme](../README.md)\n" });

  expect(push("origin", "main")).toMatchObject({ exitCode: 0, stderr: "" });
});

test("core.hooksPath=.githooks enables pre-push beside pre-commit: both are executable", () => {
  for (const hook of ["pre-commit", "pre-push"]) {
    const mode = statSync(join(import.meta.dir, "../../.githooks", hook)).mode;
    expect(mode & 0o111, hook).not.toBe(0);
  }
});
