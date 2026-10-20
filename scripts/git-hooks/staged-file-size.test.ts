import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useTestRepo } from "./test-repo";

// Each test commits in a throwaway repository whose hooks directory is this repository's real
// `.githooks`, so the real hook runs the real size ratchet against a real index.
const repositoryRoot = join(import.meta.dir, "../..");
const hooksDir = join(repositoryRoot, ".githooks");
const LIMIT_BYTES = 20_000;

const repo = useTestRepo();

function text(bytes: number): string {
  return "x".repeat(bytes);
}

function committedPaths(): string[] {
  return repo.ok("ls-tree", "-r", "-z", "--name-only", "HEAD").split("\0").filter(Boolean).sort();
}

test("the initial commit of a small file passes", () => {
  repo.write({ "small.ts": text(100) });
  repo.ok("add", "small.ts");

  expect(repo.commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual(["small.ts"]);
});

test("the initial commit of a file over the limit is blocked", () => {
  repo.write({ "big.ts": text(LIMIT_BYTES + 1) });
  repo.ok("add", "big.ts");

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("big.ts");
  expect(repo.git("rev-parse", "--verify", "-q", "HEAD").exitCode).not.toBe(0);
});

test("a new file of exactly 20,000 bytes passes and one byte more is blocked as new", () => {
  repo.seed({ "README.md": "hello\n" });
  repo.write({ "at-limit.ts": text(LIMIT_BYTES) });
  repo.ok("add", "at-limit.ts");
  expect(repo.commit().exitCode).toBe(0);

  repo.write({ "over-limit.ts": text(LIMIT_BYTES + 1) });
  repo.ok("add", "over-limit.ts");
  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("over-limit.ts");
  expect(result.stderr).toContain("5,001 tokens");
  expect(result.stderr).toContain("The limit is 5,000 tokens");
  expect(result.stderr).toContain("new file");
  expect(result.stderr).toContain("Split each file");
  expect(result.stderr).toContain("linguist-generated");
  expect(committedPaths()).toEqual(["README.md", "at-limit.ts"]);
});

test("an existing file that grows over the limit is blocked as crossing it", () => {
  repo.seed({ "grows.ts": text(19_000) });
  repo.write({ "grows.ts": text(LIMIT_BYTES + 400) });
  repo.ok("add", "grows.ts");

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("grows.ts");
  expect(result.stderr).toContain("crossed the limit");
  expect(result.stderr).toContain("crossed the limit: grew from 19,000 to 20,400 bytes");
});

test("a file already over the limit may shrink or stay the same size, but not grow", () => {
  repo.seed({ "legacy.ts": text(30_000) });

  repo.write({ "legacy.ts": text(29_001) });
  repo.ok("add", "legacy.ts");
  expect(repo.commit().exitCode).toBe(0);

  repo.ok("update-index", "--chmod=+x", "legacy.ts");
  expect(repo.commit().exitCode).toBe(0);
  expect(repo.ok("ls-tree", "HEAD", "legacy.ts")).toStartWith("100755 ");

  // 29,001 and 29,003 bytes are both 7,251 tokens: only the byte counts show the growth.
  repo.write({ "legacy.ts": text(29_003) });
  repo.ok("add", "legacy.ts");
  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("legacy.ts");
  expect(result.stderr).toContain("grew");
  expect(result.stderr).toContain("already over the limit and grew from 29,001 to 29,003 bytes");
});

test("renaming a file already over the limit without growing it passes", () => {
  repo.seed({ "old name.ts": text(30_000) });
  repo.ok("mv", "old name.ts", "new-name.ts");

  expect(repo.commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual(["new-name.ts"]);
});

test("renames are still detected when a commit exceeds git's rename limit", () => {
  repo.seed({ "one.ts": `${text(30_000)}\none\n`, "two.ts": `${text(30_000)}\ntwo\n` });
  // With a rename limit of 1, git gives up on inexact renames between these two pairs and would
  // report two deleted and two new files.
  repo.ok("config", "diff.renameLimit", "1");
  repo.ok("mv", "one.ts", "uno.ts");
  repo.ok("mv", "two.ts", "dos.ts");
  repo.write({ "uno.ts": `${text(30_000)}\nuno\n` });
  repo.write({ "dos.ts": `${text(30_000)}\ndos\n` });
  repo.ok("add", "-A");

  const result = repo.commit();

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(committedPaths()).toEqual(["dos.ts", "uno.ts"]);
});

test("the hook is checked out with LF line endings even under core.autocrlf=true", () => {
  mkdirSync(join(repo.dir, ".githooks"));
  copyFileSync(join(repositoryRoot, ".gitattributes"), join(repo.dir, ".gitattributes"));
  copyFileSync(join(hooksDir, "pre-commit"), join(repo.dir, ".githooks/pre-commit"));
  repo.seed({});
  repo.ok("config", "core.autocrlf", "true");
  rmSync(join(repo.dir, ".githooks/pre-commit"));

  repo.ok("checkout", "--", ".githooks/pre-commit");

  expect(repo.ok("check-attr", "--cached", "eol", "--", ".githooks/pre-commit")).toBe(
    ".githooks/pre-commit: eol: lf",
  );
  expect(readFileSync(join(repo.dir, ".githooks/pre-commit"), "utf8")).not.toContain("\r");
});

test("renaming a file already over the limit and growing it is blocked", () => {
  repo.seed({ "before.ts": `${text(30_000)}\n` });
  repo.ok("mv", "before.ts", "after.ts");
  repo.write({ "after.ts": `${text(30_000)}\nmore\n` });
  repo.ok("add", "after.ts");

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("after.ts");
  expect(result.stderr).toContain("grew");
});

test("a copy of a file already over the limit is blocked as new, even when the source changes", () => {
  repo.seed({ "big.ts": `${text(30_000)}\n` });
  repo.write({ "big.ts": `${text(30_000)}\nchanged\n` });
  repo.write({ "big copy.ts": `${text(30_000)}\n` });
  repo.ok("add", "-A");

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  const lines = result.stderr.split("\n");
  expect(lines.find((line) => line.includes("big copy.ts"))).toContain("new file");
  expect(lines.find((line) => line.includes("big.ts:"))).toContain("grew");
});

test("a file the staged .gitattributes marks linguist-generated passes at any size", () => {
  repo.seed({ "README.md": "hello\n" });
  repo.write({ ".gitattributes": "*.lock linguist-generated\ngen/** linguist-generated=true\n" });
  repo.write({ "deps.lock": text(500_000) });
  repo.write({ "gen/routes.ts": text(80_000) });
  repo.ok("add", "-A");

  expect(repo.commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual([".gitattributes", "README.md", "deps.lock", "gen/routes.ts"]);
});

test("a linguist-generated mark only in the working tree does not exempt a file", () => {
  repo.seed({ "README.md": "hello\n" });
  repo.write({ "deps.lock": text(LIMIT_BYTES + 1) });
  repo.ok("add", "deps.lock");
  repo.write({ ".gitattributes": "*.lock linguist-generated\n" });

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("deps.lock");
});

test("a binary file over the limit passes", () => {
  repo.seed({ "README.md": "hello\n" });
  const image = new Uint8Array(60_000).fill(0x41);
  image[10] = 0;
  repo.write({ "image.png": image });
  repo.ok("add", "image.png");

  expect(repo.commit().exitCode).toBe(0);
});

test("paths with spaces and non-ASCII characters are checked and reported verbatim", () => {
  repo.seed({ "README.md": "hello\n" });
  repo.write({ "docs/a small note.md": text(10) });
  repo.ok("add", "-A");
  expect(repo.commit().exitCode).toBe(0);

  repo.write({ "docs/größe über limit.md": text(LIMIT_BYTES + 1) });
  repo.ok("add", "-A");
  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("docs/größe über limit.md");
});

test("deleting a file over the limit passes", () => {
  repo.seed({ "legacy.ts": text(30_000), "keep.ts": "x\n" });
  repo.ok("rm", "-q", "legacy.ts");

  expect(repo.commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual(["keep.ts"]);
});

test("sizes come from the staged blob, not the working tree", () => {
  repo.seed({ "file.ts": "x\n" });
  repo.write({ "file.ts": "y\n" });
  repo.ok("add", "file.ts");
  repo.write({ "file.ts": text(LIMIT_BYTES * 3) });

  expect(repo.commit().exitCode).toBe(0);
  expect(repo.ok("cat-file", "-s", "HEAD:file.ts").trim()).toBe("2");
});

test("commit -a checks the index git commits from", () => {
  repo.seed({ "file.ts": "x\n" });
  repo.write({ "file.ts": text(LIMIT_BYTES + 1) });

  const result = repo.commit("-a");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("file.ts");
});

test("every blocked file is listed with its own reason", () => {
  repo.seed({ "crossing.ts": text(100), "growing.ts": text(25_000), "fine.ts": "x\n" });
  repo.write({ "crossing.ts": text(21_000) });
  repo.write({ "growing.ts": text(26_000) });
  repo.write({ "fresh.ts": text(22_000) });
  repo.write({ "fine.ts": "y\n" });
  repo.ok("add", "-A");

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  const lines = result.stderr.split("\n");
  expect(lines.find((line) => line.includes("crossing.ts"))).toContain("crossed the limit");
  expect(lines.find((line) => line.includes("growing.ts"))).toContain("grew");
  expect(lines.find((line) => line.includes("fresh.ts"))).toContain("new file");
  expect(result.stderr).not.toContain("fine.ts");
});
