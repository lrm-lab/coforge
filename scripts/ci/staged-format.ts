import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = realpathSync(join(import.meta.dir, "../.."));
const worktree = process.cwd();
const formatPath = /\.(?:[cm]?[jt]sx?|jsonc?|css|scss|less)$/i;
export const ROOT_FORMAT_DIRECTORIES = new Set([
  "audit",
  "ci",
  "dev",
  "deploy",
  "docs",
  "git-hooks",
  "migration-safety",
  "ops",
  "reference-computer",
  "release",
  "test",
]);
export const ROOT_FORMAT_FILES = new Set([
  "scripts/verify-oss-cdn.test.ts",
  "scripts/verify-oss-cdn.ts",
]);
const formatPathspecs = [
  "*.cjs",
  "*.css",
  "*.cts",
  "*.js",
  "*.json",
  "*.json5",
  "*.jsonc",
  "*.jsx",
  "*.less",
  "*.mjs",
  "*.mts",
  "*.scss",
  "*.ts",
  "*.tsx",
];

function run(command: string[], options: Bun.SpawnOptions = {}) {
  return Bun.spawnSync(command, { cwd: worktree, ...options });
}

function git(...args: string[]): Uint8Array {
  const result = run(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function nulSeparated(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split("\0").filter(Boolean);
}

function stagedFiles(): string[] {
  return nulSeparated(
    git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--", ...formatPathspecs),
  ).filter((path) => formatPath.test(path) && isFormatScope(path));
}

function isFormatScope(path: string): boolean {
  if (path.startsWith("apps/") || path.startsWith("packages/")) return true;
  if (ROOT_FORMAT_FILES.has(path)) return true;
  return path.startsWith("scripts/") && ROOT_FORMAT_DIRECTORIES.has(path.split("/")[1] ?? "");
}

function stagedBlob(path: string): Uint8Array {
  return git("cat-file", "blob", `:${path}`);
}

function stagedConfigFiles(): string[] {
  return nulSeparated(git("ls-files", "-z", "--", "*oxfmtrc*", ".prettierignore"));
}

export function checkOxfmtAvailable(
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
  root = repositoryRoot,
): boolean {
  const result = spawn([process.execPath, "x", "--no-install", "oxfmt", "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return true;
  console.error(
    "pre-commit: oxfmt is not installed; run `bun install` (or `mise install`) first. " +
      "Do not use --no-verify to bypass this check; the push hook and CI check formatting too.",
  );
  return false;
}

export function runStagedFormat(): number {
  const files = stagedFiles();
  if (files.length === 0) return 0;
  if (!checkOxfmtAvailable()) return 1;

  const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), "coforge-staged-format-"));
  try {
    const temporaryFiles: string[] = [];
    for (const path of [...stagedConfigFiles(), ...files]) {
      const temporaryPath = join(temporaryRoot, path);
      mkdirSync(dirname(temporaryPath), { recursive: true });
      writeFileSync(temporaryPath, stagedBlob(path));
      if (files.includes(path)) temporaryFiles.push(temporaryPath);
    }

    const result = Bun.spawnSync(
      [process.execPath, "x", "--no-install", "oxfmt", "--check", "--", ...temporaryFiles],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
      if (output) console.error(output);
      console.error(
        "pre-commit: staged files are not formatted. Run `bunx oxfmt --write <file>` and stage " +
          "the result, then commit again.",
      );
      return 1;
    }
    return 0;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(runStagedFormat());
