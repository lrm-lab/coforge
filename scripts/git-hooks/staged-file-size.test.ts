import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Each test commits in a throwaway repository whose hooks directory is this repository's real
// `.githooks`, so the real hook runs the real script against a real index.
const repositoryRoot = join(import.meta.dir, "../..");
const hooksDir = join(repositoryRoot, ".githooks");
const LIMIT_BYTES = 20_000;

let home: string;
let repo: string;

/** Git's environment for the throwaway repository: none of the host's git variables (an Agent's
 * injected `GIT_CONFIG_*`, a parent hook's `GIT_INDEX_FILE`), no user or system config, and the
 * test's own `bun` first on PATH for the hook. */
function gitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("GIT_")) environment[name] = value;
  return {
    ...environment,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
  };
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnvironment() });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function ok(...args: string[]): string {
  const result = git(...args);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

function write(path: string, content: string | Uint8Array) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function text(bytes: number): string {
  return "x".repeat(bytes);
}

/** Commits `files` without running the hook: the history a test starts from. */
function seed(files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) write(path, content);
  ok("add", "-A");
  ok("commit", "-q", "--no-verify", "-m", "seed");
}

function commit(...extra: string[]) {
  return git("commit", "-q", "-m", "change", ...extra);
}

function committedPaths(): string[] {
  return ok("ls-tree", "-r", "-z", "--name-only", "HEAD").split("\0").filter(Boolean).sort();
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "coforge-staged-file-size-")));
  repo = join(home, "repo");
  mkdirSync(repo);
  writeFileSync(join(home, "gitconfig"), "");
  ok("init", "-q", "-b", "main");
  ok("config", "core.hooksPath", hooksDir);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("the initial commit of a small file passes", () => {
  write("small.ts", text(100));
  ok("add", "small.ts");

  expect(commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual(["small.ts"]);
});

test("the initial commit of a file over the limit is blocked", () => {
  write("big.ts", text(LIMIT_BYTES + 1));
  ok("add", "big.ts");

  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("big.ts");
  expect(git("rev-parse", "--verify", "-q", "HEAD").exitCode).not.toBe(0);
});

test("a new file of exactly 20,000 bytes passes and one byte more is blocked as new", () => {
  seed({ "README.md": "hello\n" });
  write("at-limit.ts", text(LIMIT_BYTES));
  ok("add", "at-limit.ts");
  expect(commit().exitCode).toBe(0);

  write("over-limit.ts", text(LIMIT_BYTES + 1));
  ok("add", "over-limit.ts");
  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("over-limit.ts");
  expect(result.stderr).toContain("5,001 tokens");
  expect(result.stderr).toContain("5,000-token limit");
  expect(result.stderr).toContain("new file");
  expect(result.stderr).toContain("Split the file");
  expect(result.stderr).toContain("linguist-generated");
  expect(committedPaths()).toEqual(["README.md", "at-limit.ts"]);
});

test("an existing file that grows over the limit is blocked as crossing it", () => {
  seed({ "grows.ts": text(19_000) });
  write("grows.ts", text(LIMIT_BYTES + 400));
  ok("add", "grows.ts");

  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("grows.ts");
  expect(result.stderr).toContain("crossed the limit");
  expect(result.stderr).toContain("crossed the limit: grew from 19,000 to 20,400 bytes");
});

test("a file already over the limit may shrink or stay the same size, but not grow", () => {
  seed({ "legacy.ts": text(30_000) });

  write("legacy.ts", text(29_001));
  ok("add", "legacy.ts");
  expect(commit().exitCode).toBe(0);

  ok("update-index", "--chmod=+x", "legacy.ts");
  expect(commit().exitCode).toBe(0);
  expect(ok("ls-tree", "HEAD", "legacy.ts")).toStartWith("100755 ");

  // 29,001 and 29,003 bytes are both 7,251 tokens: only the byte counts show the growth.
  write("legacy.ts", text(29_003));
  ok("add", "legacy.ts");
  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("legacy.ts");
  expect(result.stderr).toContain("grew");
  expect(result.stderr).toContain("already over the limit and grew from 29,001 to 29,003 bytes");
});

test("renaming a file already over the limit without growing it passes", () => {
  seed({ "old name.ts": text(30_000) });
  ok("mv", "old name.ts", "new-name.ts");

  expect(commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual(["new-name.ts"]);
});

test("renames are still detected when a commit exceeds git's rename limit", () => {
  seed({ "one.ts": `${text(30_000)}\none\n`, "two.ts": `${text(30_000)}\ntwo\n` });
  // With a rename limit of 1, git gives up on inexact renames between these two pairs and would
  // report two deleted and two new files.
  ok("config", "diff.renameLimit", "1");
  ok("mv", "one.ts", "uno.ts");
  ok("mv", "two.ts", "dos.ts");
  write("uno.ts", `${text(30_000)}\nuno\n`);
  write("dos.ts", `${text(30_000)}\ndos\n`);
  ok("add", "-A");

  const result = commit();

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(committedPaths()).toEqual(["dos.ts", "uno.ts"]);
});

test("the hook is checked out with LF line endings even under core.autocrlf=true", () => {
  mkdirSync(join(repo, ".githooks"));
  copyFileSync(join(repositoryRoot, ".gitattributes"), join(repo, ".gitattributes"));
  copyFileSync(join(hooksDir, "pre-commit"), join(repo, ".githooks/pre-commit"));
  ok("add", "-A");
  ok("commit", "-q", "--no-verify", "-m", "seed");
  ok("config", "core.autocrlf", "true");
  rmSync(join(repo, ".githooks/pre-commit"));

  ok("checkout", "--", ".githooks/pre-commit");

  expect(ok("check-attr", "--cached", "eol", "--", ".githooks/pre-commit")).toBe(
    ".githooks/pre-commit: eol: lf\n",
  );
  expect(readFileSync(join(repo, ".githooks/pre-commit"), "utf8")).not.toContain("\r");
});

test("renaming a file already over the limit and growing it is blocked", () => {
  seed({ "before.ts": `${text(30_000)}\n` });
  ok("mv", "before.ts", "after.ts");
  write("after.ts", `${text(30_000)}\nmore\n`);
  ok("add", "after.ts");

  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("after.ts");
  expect(result.stderr).toContain("grew");
});

test("a copy of a file already over the limit is blocked as new, even when the source changes", () => {
  seed({ "big.ts": `${text(30_000)}\n` });
  write("big.ts", `${text(30_000)}\nchanged\n`);
  write("big copy.ts", `${text(30_000)}\n`);
  ok("add", "-A");

  const result = commit();

  expect(result.exitCode).not.toBe(0);
  const lines = result.stderr.split("\n");
  expect(lines.find((line) => line.includes("big copy.ts"))).toContain("new file");
  expect(lines.find((line) => line.includes("big.ts:"))).toContain("grew");
});

test("a file the staged .gitattributes marks linguist-generated passes at any size", () => {
  seed({ "README.md": "hello\n" });
  write(".gitattributes", "*.lock linguist-generated\ngen/** linguist-generated=true\n");
  write("deps.lock", text(500_000));
  write("gen/routes.ts", text(80_000));
  ok("add", "-A");

  expect(commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual([".gitattributes", "README.md", "deps.lock", "gen/routes.ts"]);
});

test("a linguist-generated mark only in the working tree does not exempt a file", () => {
  seed({ "README.md": "hello\n" });
  write("deps.lock", text(LIMIT_BYTES + 1));
  ok("add", "deps.lock");
  write(".gitattributes", "*.lock linguist-generated\n");

  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("deps.lock");
});

test("a binary file over the limit passes", () => {
  seed({ "README.md": "hello\n" });
  const image = new Uint8Array(60_000).fill(0x41);
  image[10] = 0;
  write("image.png", image);
  ok("add", "image.png");

  expect(commit().exitCode).toBe(0);
});

test("paths with spaces and non-ASCII characters are checked and reported verbatim", () => {
  seed({ "README.md": "hello\n" });
  write("docs/a small note.md", text(10));
  ok("add", "-A");
  expect(commit().exitCode).toBe(0);

  write("docs/größe über limit.md", text(LIMIT_BYTES + 1));
  ok("add", "-A");
  const result = commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("docs/größe über limit.md");
});

test("deleting a file over the limit passes", () => {
  seed({ "legacy.ts": text(30_000), "keep.ts": "x\n" });
  ok("rm", "-q", "legacy.ts");

  expect(commit().exitCode).toBe(0);
  expect(committedPaths()).toEqual(["keep.ts"]);
});

test("sizes come from the staged blob, not the working tree", () => {
  seed({ "file.ts": "x\n" });
  write("file.ts", "y\n");
  ok("add", "file.ts");
  write("file.ts", text(LIMIT_BYTES * 3));

  expect(commit().exitCode).toBe(0);
  expect(ok("cat-file", "-s", "HEAD:file.ts").trim()).toBe("2");
});

test("commit -a checks the index git commits from", () => {
  seed({ "file.ts": "x\n" });
  write("file.ts", text(LIMIT_BYTES + 1));

  const result = commit("-a");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("file.ts");
});

test("every blocked file is listed with its own reason", () => {
  seed({ "crossing.ts": text(100), "growing.ts": text(25_000), "fine.ts": "x\n" });
  write("crossing.ts", text(21_000));
  write("growing.ts", text(26_000));
  write("fresh.ts", text(22_000));
  write("fine.ts", "y\n");
  ok("add", "-A");

  const result = commit();

  expect(result.exitCode).not.toBe(0);
  const lines = result.stderr.split("\n");
  expect(lines.find((line) => line.includes("crossing.ts"))).toContain("crossed the limit");
  expect(lines.find((line) => line.includes("growing.ts"))).toContain("grew");
  expect(lines.find((line) => line.includes("fresh.ts"))).toContain("new file");
  expect(result.stderr).not.toContain("fine.ts");
});
