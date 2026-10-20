// A throwaway git repository for the hook and hard-rules tests. Its hooks directory is this
// repository's real `.githooks`, so a commit runs the real pre-commit hook, and `range` and `all`
// run the real checker. `useTestRepo()` creates a fresh one before each test and removes it after,
// pass or fail.
import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../..");
const checker = join(repositoryRoot, "scripts/ci/hard-rules.ts");

export type Run = { exitCode: number; stdout: string; stderr: string };

export class TestRepo {
  home = "";
  dir = "";

  open() {
    this.home = realpathSync(mkdtempSync(join(tmpdir(), "coforge-test-repo-")));
    this.dir = join(this.home, "repo");
    mkdirSync(this.dir);
    writeFileSync(join(this.home, "gitconfig"), "");
    this.ok("init", "-q", "-b", "main");
    this.ok("config", "core.hooksPath", join(repositoryRoot, ".githooks"));
  }

  dispose() {
    if (this.home) rmSync(this.home, { recursive: true, force: true });
    this.home = "";
  }

  /** None of the host's git variables (an Agent's `GIT_CONFIG_*`, a parent hook's
   * `GIT_INDEX_FILE`), no user or system config, a human author, and the test's `bun` on PATH. */
  private environment(overrides: Record<string, string>): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && !name.startsWith("GIT_")) environment[name] = value;
    return {
      ...environment,
      HOME: this.home,
      GIT_CONFIG_GLOBAL: join(this.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Person",
      GIT_AUTHOR_EMAIL: "person@example.com",
      GIT_COMMITTER_NAME: "Test Person",
      GIT_COMMITTER_EMAIL: "person@example.com",
      PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
      ...overrides,
    };
  }

  run(command: string[], env: Record<string, string> = {}, cwd = this.dir, input?: string): Run {
    const stdin = input === undefined ? "ignore" : Buffer.from(input);
    const result = Bun.spawnSync(command, { cwd, env: this.environment(env), stdin });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  git(...args: string[]): Run {
    return this.run(["git", ...args]);
  }

  ok(...args: string[]): string {
    const result = this.git(...args);
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
    return result.stdout.trim();
  }

  write(files: Record<string, string | Uint8Array>) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(join(this.dir, path), content);
    }
  }

  /** Commits `files` and everything else in the work tree without the hook (the history a test
   * starts from), and returns the commit. */
  seed(
    files: Record<string, string | Uint8Array>,
    { message = "seed", env = {} }: { message?: string; env?: Record<string, string> } = {},
  ): string {
    this.write(files);
    this.ok("add", "-A");
    const result = this.run(
      ["git", "commit", "-q", "--no-verify", "--allow-empty", "-m", message],
      env,
    );
    if (result.exitCode !== 0) throw new Error(`seed commit failed: ${result.stderr}`);
    return this.head();
  }

  /** `git commit` of the index as it is, with the hook. */
  commit(...args: string[]): Run {
    return this.run(["git", "commit", "-q", "-m", "change", ...args]);
  }

  /** `git commit` with the hook, after staging everything. */
  commitAll(env: Record<string, string> = {}, ...args: string[]): Run {
    this.ok("add", "-A");
    return this.run(["git", "commit", "-q", "-m", "change", ...args], env);
  }

  /** The checker with `args`. */
  check(args: string[], env: Record<string, string> = {}): Run {
    return this.run([process.execPath, checker, ...args], env);
  }

  /** The checker in CI's mode over `base`..`head`, with any further options. */
  range(base: string, head = "HEAD", ...options: string[]): Run {
    return this.check(["--range", base, head, ...options]);
  }

  /** The checker in whole-tree mode. */
  all(): Run {
    return this.check(["--all"]);
  }

  head(): string {
    return this.ok("rev-parse", "HEAD");
  }
}

/** A repository that is fresh in every test of the file. */
export function useTestRepo(): TestRepo {
  const repo = new TestRepo();
  beforeEach(() => repo.open());
  afterEach(() => repo.dispose());
  return repo;
}
