import { describe, expect, test } from "bun:test";
import {
  exemptReason,
  hasConventionalTitle,
  hasRevertEffect,
  mixStats,
  rangeGranularity,
  sub100Renames,
} from "./commit-granularity";
import { useTestRepo } from "../git-hooks/test-repo";

const repo = useTestRepo();

const LONG = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
const EXTRA = (n: number) =>
  Array.from({ length: n }, (_, i) => `behavior ${i} ${"y".repeat(30)}`).join("\n");

describe("message rules", () => {
  test("Revert-effect requires a non-empty value", () => {
    expect(hasRevertEffect("subject\n\nRevert-effect: readers lose the count\n")).toBe(true);
    expect(hasRevertEffect("subject\n\nRevert-effect: none\n")).toBe(true);
    expect(hasRevertEffect("subject\n\nRevert-effect:\n")).toBe(false);
    expect(hasRevertEffect("subject\n\nRevert-effected: nope\n")).toBe(false);
    expect(hasRevertEffect("subject only\n")).toBe(false);
  });

  test("Granularity-exempt needs a reason", () => {
    expect(exemptReason("s\n\nGranularity-exempt: release pairing\n")).toBe("release pairing");
    expect(exemptReason("s\n\nGranularity-exempt:\n")).toBeUndefined();
    expect(exemptReason("s\n")).toBeUndefined();
  });
});

describe("commit title", () => {
  test("a Conventional Commit title passes, with a scope or a breaking mark", () => {
    for (const title of [
      "feat: add a thing",
      "fix(web): the share dialog's row",
      "refactor(web)!: drop the old seam",
      "revert: undo the change",
      'Revert "feat: add a thing"',
      "Merge branch 'main' into x",
      "fixup! feat: add a thing",
      "squash! fix: a",
    ])
      expect({ title, ok: hasConventionalTitle(`${title}\n\nRevert-effect: none\n`) }).toEqual({
        title,
        ok: true,
      });
  });

  test("anything else fails: no type, an unknown type, no space, an empty description", () => {
    for (const title of [
      "daemon: give OpenCode ten minutes to start",
      "Task popup: chips row scrolls sideways only",
      "feature: add a thing",
      "feat:add a thing",
      "feat: ",
      "feat(): a",
      "Add a thing",
      "",
    ])
      expect({ title, ok: hasConventionalTitle(`${title}\n\nRevert-effect: none\n`) }).toEqual({
        title,
        ok: false,
      });
  });

  test("comment lines before the title are ignored", () => {
    expect(hasConventionalTitle("# Please enter a message\nfix: a\n")).toBe(true);
  });
});

describe("sub100Renames", () => {
  test("only R<100 entries", () => {
    const listing = "R100\ta.ts\tb.ts\nR87\tc.ts\td.ts\nM\te.ts\n";
    expect(sub100Renames(listing)).toEqual(["c.ts -> d.ts"]);
  });
});

describe("mixStats", () => {
  const moved = LONG(40);
  test("a pure extraction has a low non-move share", () => {
    const patch = [
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ b/old.ts",
      "@@ -1,40 +0,0 @@",
      ...moved.split("\n").map((l) => `-${l}`),
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,40 @@",
      ...moved.split("\n").map((l) => `+${l}`),
      "",
    ].join("\n");
    const stats = mixStats(patch);
    // Each of the 40 relocated lines counts where it left and where it landed.
    expect(stats?.moved).toBe(80);
    expect(stats?.nonMove).toBe(0);
  });

  test("moved lines plus behavior changes exceed the ratio", () => {
    const extra = EXTRA(60)
      .split("\n")
      .map((l) => `+${l}`);
    const patch = [
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ b/old.ts",
      "@@ -1,40 +1,60 @@",
      ...moved.split("\n").map((l) => `-${l}`),
      ...extra,
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,40 @@",
      ...moved.split("\n").map((l) => `+${l}`),
      "",
    ].join("\n");
    const stats = mixStats(patch);
    expect(stats).toBeDefined();
    expect(stats!.moved).toBe(80);
    expect(stats!.ratio).toBeGreaterThanOrEqual(0.4);
  });

  test("under 30 moved lines is not judged", () => {
    const few = LONG(10);
    const patch = [
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ b/old.ts",
      "@@ -1,10 +0,0 @@",
      ...few.split("\n").map((l) => `-${l}`),
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,10 @@",
      ...few.split("\n").map((l) => `+${l}`),
      "",
    ].join("\n");
    expect(mixStats(patch)).toBeUndefined();
  });

  test("lines re-indented in place are not moved", () => {
    const patch = [
      "diff --git a/pane.tsx b/pane.tsx",
      "--- a/pane.tsx",
      "+++ b/pane.tsx",
      "@@ -1,40 +1,42 @@",
      ...moved.split("\n").map((l) => `-${l}`),
      "+<Wrapper>",
      ...moved.split("\n").map((l) => `+  ${l}`),
      "+</Wrapper>",
      "",
    ].join("\n");
    expect(mixStats(patch)).toBeUndefined();
  });

  test("lines moved into an existing file are not judged", () => {
    const patch = [
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ b/old.ts",
      "@@ -1,40 +0,0 @@",
      ...moved.split("\n").map((l) => `-${l}`),
      "diff --git a/other.ts b/other.ts",
      "--- a/other.ts",
      "+++ b/other.ts",
      "@@ -1,0 +1,40 @@",
      ...moved.split("\n").map((l) => `+${l}`),
      "",
    ].join("\n");
    expect(mixStats(patch)).toBeUndefined();
  });
});

describe("range checks", () => {
  test("a commit without Revert-effect fails; with it passes", () => {
    repo.seed({ "a.txt": "hello\n" });
    repo.write({ "a.txt": "hello world\n" });
    repo.ok("add", "-A");
    const bad = repo.run(["git", "commit", "-q", "-m", "no trailer"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("Revert-effect");
    repo.ok("reset", "-q", "HEAD");
    expect(repo.commitAll().exitCode).toBe(0);
  });

  test("the commit-msg hook refuses a title that is not a Conventional Commit", () => {
    repo.seed({ "a.txt": "hello\n" });
    repo.write({ "a.txt": "hello world\n" });
    repo.ok("add", "-A");

    const bad = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "Tweak things",
      "-m",
      "Revert-effect: none",
    ]);

    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("not a Conventional Commit");
    expect(bad.stderr).not.toContain("Revert-effect trailer");
    const good = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "fix: tweak things",
      "-m",
      "Revert-effect: none",
    ]);
    expect(good.exitCode).toBe(0);
  });

  test("range mode flags a title that is not a Conventional Commit, merges excepted", () => {
    const base = repo.seed({ "a.txt": "one\n" });
    repo.write({ "b.txt": "two\n" });
    repo.ok("add", "-A");
    repo.ok("commit", "-q", "--no-verify", "-m", "Tweak things", "-m", "Revert-effect: none");

    const result = repo.range(base, repo.head());

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("commit-title");
    expect(result.stderr).toContain("Tweak things");
    expect(result.stderr).not.toContain("revert-effect");
  });

  test("range mode flags a commit without the trailer", () => {
    const base = repo.seed({ "a.txt": "one\n" });
    repo.write({ "b.txt": "two\n" });
    repo.ok("add", "-A");
    repo.ok("commit", "-q", "--no-verify", "-m", "chore: seed without trailer");
    const head = repo.head();
    const result = repo.range(base, head);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("revert-effect");
  });

  test("Granularity-exempt bypasses mix but the commit still needs Revert-effect", () => {
    const base = repo.seed({ "old.ts": `${LONG(40)}\n` });
    const mixedFiles = () => {
      repo.write({ "new.ts": `${LONG(40)}\n${EXTRA(60)}\n` });
      repo.ok("rm", "-q", "old.ts");
      repo.ok("add", "-A");
    };
    // The mixed commit lands (staged checks cannot see the message), then --range flags it.
    mixedFiles();
    expect(
      repo.run(["git", "commit", "-q", "-m", "feat: move and change", "-m", "Revert-effect: none"])
        .exitCode,
    ).toBe(0);
    const flagged = repo.range(base, "HEAD");
    expect(flagged.exitCode).not.toBe(0);
    expect(flagged.stderr).toContain("commit-mix");
    // The same shape with the exempt trailer passes and is reported.
    repo.ok("reset", "-q", "--hard", base);
    mixedFiles();
    expect(
      repo.run([
        "git",
        "commit",
        "-q",
        "-m",
        "feat: move and change",
        "-m",
        "Revert-effect: the pairing must land together",
        "-m",
        "Granularity-exempt: release pairing needs both halves atomic",
      ]).exitCode,
    ).toBe(0);
    const ok = repo.range(base, "HEAD");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("Granularity exemptions used");
  });

  test("a git failure is an error, not an empty pass", () => {
    expect(() => rangeGranularity("0".repeat(40), "HEAD")).toThrow(/git rev-list/);
  });
});
