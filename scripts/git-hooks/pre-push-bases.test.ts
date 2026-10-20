import { expect, test } from "bun:test";
import { join } from "node:path";
import { useTestRepo } from "./test-repo";

// Which base the pre-push hook judges each ref from, and which commits' identities it checks: the
// later of the ref's fork point from its remote sha and from origin/main, so a branch that merged
// or rebased onto main is never blamed for main's commits; identities of only the pushed commits.
const repo = useTestRepo();
const BIG = "x".repeat(20_001);
const BOT = { GIT_AUTHOR_NAME: "renovate[bot]" };
const hook = join(import.meta.dir, "pre-push.ts");

function withOrigin() {
  const remote = `${repo.home}/origin.git`;
  repo.ok("init", "-q", "--bare", remote);
  repo.ok("remote", "add", "origin", remote);
  repo.ok("push", "-q", "--no-verify", "-u", "origin", "main");
}

const push = (...args: string[]) => repo.git("push", "-q", ...args);

/** A pushed branch `feat` with one commit, made by `env`. */
function pushedFeat(files: Record<string, string> = { "feat.md": "# Feat\n" }, env = {}) {
  repo.ok("switch", "-q", "-c", "feat");
  repo.seed(files, { env });
  repo.ok("push", "-q", "--no-verify", "-u", "origin", "feat");
}

/** main gains a bot-authored oversized file elsewhere, pushed without the hook; back on `feat`. */
function mainAdvances() {
  repo.ok("switch", "-q", "main");
  repo.seed({ "vendor.ts": BIG }, { env: BOT });
  repo.ok("push", "-q", "--no-verify", "origin", "main");
  repo.ok("switch", "-q", "feat");
}

test("a branch that merged origin/main is not blamed for main's commits", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat();
  mainAdvances();
  repo.ok("merge", "-q", "--no-edit", "origin/main");

  expect(push("origin", "feat")).toMatchObject({ exitCode: 0, stderr: "" });
});

test("a branch rebased onto origin/main and force-pushed is not blamed for main's commits", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat();
  mainAdvances();
  repo.ok("rebase", "-q", "origin/main");

  expect(push("--force", "origin", "feat")).toMatchObject({ exitCode: 0, stderr: "" });
});

test("after merging origin/main, the branch's own new violation is still blocked", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat();
  mainAdvances();
  repo.ok("merge", "-q", "--no-edit", "origin/main");
  repo.seed({ "mine.ts": BIG });

  const result = push("origin", "feat");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("mine.ts: 5,001 tokens");
  expect(result.stderr).not.toContain("vendor.ts");
  expect(result.stderr).toContain("refs/heads/feat");
});

test("identities: a bot commit already on the branch's remote is not re-reported, a pushed one is", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat({ "feat.md": "# Feat\n" }, BOT);
  mainAdvances();
  repo.ok("merge", "-q", "--no-edit", "origin/main");
  expect(push("origin", "feat")).toMatchObject({ exitCode: 0, stderr: "" });

  repo.seed({ "more.md": "# More\n" }, { env: BOT });
  const result = push("origin", "feat");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("author renovate[bot]");
});

test("a ref the remote has is judged from its remote sha: its own earlier violation is not new", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat({ "old.ts": BIG });
  repo.seed({ "feat.md": "# Feat\n" });

  expect(push("origin", "feat")).toMatchObject({ exitCode: 0, stderr: "" });
});

test("every ref is judged: a clean first ref does not let a bad second one through", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  repo.ok("switch", "-q", "-c", "a-clean");
  repo.seed({ "a.md": "# A\n" });
  repo.ok("switch", "-q", "-c", "b-bad", "main");
  repo.seed({ "b.ts": BIG });

  const result = push("origin", "a-clean", "b-bad");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("pre-push: refs/heads/b-bad -> refs/heads/b-bad breaks");
  expect(result.stderr).not.toContain("refs/heads/a-clean -> refs/heads/a-clean breaks");
});

test("a force-push that rewrites a commit is judged on what it sends", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat();
  repo.write({ "big.ts": BIG });
  repo.ok("add", "-A");
  repo.ok("commit", "-q", "--no-verify", "--amend", "--no-edit");
  expect(push("--force", "origin", "feat").exitCode).not.toBe(0);

  repo.ok("rm", "-q", "big.ts");
  repo.ok("commit", "-q", "--no-verify", "--amend", "--no-edit");
  expect(push("--force", "origin", "feat")).toMatchObject({ exitCode: 0, stderr: "" });
});

test("a remote sha unknown here falls back to the merge base with origin/main", () => {
  repo.seed({ "legacy.ts": BIG });
  withOrigin();
  repo.ok("switch", "-q", "-c", "feat");
  const local = repo.seed({ "mine.ts": BIG });
  const line = `refs/heads/feat ${local} refs/heads/feat ${"1".repeat(40)}\n`;

  const result = repo.run([process.execPath, hook], {}, repo.dir, line);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("mine.ts");
  expect(result.stderr).not.toContain("legacy.ts");
  // origin/main stands in for the unknown remote ref; a stale one can blame main's commits.
  expect(result.stderr).toContain(
    "the remote sha is unknown here, so it was judged from origin/main: run `git fetch origin` " +
      "and push again if main's commits are listed",
  );
});

test("a ref with no history in common is skipped with a warning, new or force-pushed", () => {
  repo.seed({ "README.md": "# Repo\n" });
  withOrigin();
  pushedFeat();
  repo.ok("switch", "-q", "--orphan", "other");
  repo.seed({ "other.ts": BIG });

  for (const args of [
    ["origin", "other:fresh"],
    ["--force", "origin", "other:feat"],
  ]) {
    const result = push(...args);
    expect(result.exitCode, args.join(" ")).toBe(0);
    expect(result.stderr).toContain("was not checked here");
  }
});

test("bad input to the checker skips the ref with a warning instead of blocking it", () => {
  repo.seed({ "README.md": "# Repo\n", "skills-lock.json": "{ not json" });
  withOrigin();
  repo.ok("switch", "-q", "-c", "feat");
  repo.seed({ "docs/a.md": "[readme](../README.md)\n" });

  const result = push("origin", "feat");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("hard-rules: skills-lock.json");
  expect(result.stderr).toContain("was not checked here");
});
