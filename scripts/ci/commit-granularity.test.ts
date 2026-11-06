import { describe, expect, test } from "bun:test";
import {
  exemptReason,
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
    // movedAdded + movedDeleted both count the same 40 relocated lines.
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

  test("range mode flags a commit without the trailer", () => {
    const base = repo.seed({ "a.txt": "one\n" });
    repo.write({ "b.txt": "two\n" });
    repo.ok("add", "-A");
    repo.ok("commit", "-q", "--no-verify", "-m", "seed without trailer");
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
