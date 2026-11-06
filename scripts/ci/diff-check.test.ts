import { expect, test } from "bun:test";
import { join } from "node:path";
import { useTestRepo } from "../git-hooks/test-repo";

// diff-check.ts is the whitespace half of range-checks.ts: the same
// `git diff --check` CI's "Select checks" step runs, over the range's merge
// base, so pre-push refuses what CI would reject after the fact (task #628).
const repo = useTestRepo();
const checker = join(import.meta.dir, "diff-check.ts");
const check = (args: string[]) => repo.run([process.execPath, checker, ...args]);

test("a clean range passes", () => {
  const base = repo.seed({ "a.txt": "a\n" });
  repo.seed({ "b.txt": "b\n" });

  expect(check(["--range", base, "HEAD"])).toMatchObject({ exitCode: 0 });
});

test("a blank line at EOF and trailing whitespace are blocked with their files", () => {
  const base = repo.seed({ "a.txt": "a\n" });
  repo.seed({ "bad.txt": "line\n\n", "space.txt": "x \n" });

  const result = check(["--range", base, "HEAD"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("bad.txt");
  expect(result.stderr).toContain("space.txt");
});

test("a later fixing commit cures the range, as the hard rules' diff does", () => {
  const base = repo.seed({ "a.txt": "a\n" });
  repo.seed({ "bad.txt": "x\n\n" });
  repo.seed({ "bad.txt": "x\n" });

  expect(check(["--range", base, "HEAD"])).toMatchObject({ exitCode: 0 });
});

test("judges from the merge base, like the hard rules and CI's BASE...HEAD", () => {
  // bad.txt's trailing whitespace predates the fork. On main it is deleted
  // after the branch, so a two-dot `main..head` diff would re-add it and
  // blame the branch for a line it never touched.
  const base = repo.seed({ "bad.txt": "x \n", "keep.txt": "k\n" });
  repo.ok("switch", "-q", "-c", "feature");
  repo.seed({ "feature.txt": "f\n" });
  const head = repo.head();
  repo.ok("switch", "-q", "main");
  repo.ok("rm", "bad.txt");
  repo.seed({});

  expect(check(["--range", "main", head])).toMatchObject({ exitCode: 0 });
  expect(base).toBeTruthy();
});

test("--authors-since pairs the orchestrator forwards are ignored", () => {
  const base = repo.seed({ "a.txt": "a\n" });
  repo.seed({ "bad.txt": "x\n\n" });

  const result = check(["--range", base, "HEAD", "--authors-since", base]);

  expect(result.exitCode).toBe(1);
});

test("bad input exits 2 with one line", () => {
  for (const args of [[], ["--range"], ["--range", "HEAD"], ["--all"]]) {
    const result = check(args);
    expect(result.exitCode, args.join(" ")).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  }
});

test("no base commit warns and passes, like the hard rules' NO_BASE", () => {
  repo.seed({ "a.txt": "a\n" });

  const result = check(["--range", "no-such-ref", "HEAD"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("No base commit");
});
