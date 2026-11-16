// Points this repository's `core.hooksPath` at the committed `.githooks` directory. The root
// package's `prepare` script runs it from the package root on every `bun install`, so it must
// never fail the install: outside a git work tree (a Docker build context, an unpacked tarball),
// without git, or below another repository's top level it does nothing. It never replaces a
// hooks path someone else configured; it prints one line instead.
//
// usage: bun scripts/git-hooks/install-hooks-path.ts   (from the repository root)
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const HOOKS_PATH = ".githooks";

function git(...args: string[]): { exitCode: number; stdout: string } | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  } catch {
    return undefined; // git is not installed
  }
}

function install(): void {
  // Only from the top of a work tree: a non-empty prefix means this package root sits inside some
  // other repository. Git compares the paths itself, which a string comparison of top-level paths
  // gets wrong on Windows (drive-letter case, separators).
  const location = git("rev-parse", "--is-inside-work-tree", "--show-prefix");
  if (location?.exitCode !== 0) return;
  const [insideWorkTree, prefix] = location.stdout.split("\n");
  if (insideWorkTree !== "true" || prefix !== "") return;

  // `command` scope is GIT_CONFIG_* or `-c`: a CoForge Agent's injected shim directory, which
  // forwards to whatever the repository configures, so it is not a choice to respect.
  const configured = git("config", "--show-scope", "--get-all", "core.hooksPath");
  const values = (configured?.exitCode === 0 ? configured.stdout : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [scope, ...value] = line.split("\t");
      return { scope, value: value.join("\t") };
    })
    .filter(({ scope }) => scope !== "command");
  // A local path naming one checkout's own `.githooks` absolutely is ours too, but wrong: every
  // worktree would run that checkout's hooks and the scripts beside them, not its own (task #121).
  const pinned = values.filter(
    ({ scope, value }) => scope === "local" && worktreeHooks().has(canonical(value)),
  );
  if (pinned.length > 0) {
    git("config", "--local", "--replace-all", "core.hooksPath", HOOKS_PATH);
    console.log(
      `CoForge git hooks: core.hooksPath was "${pinned[0]!.value}", now ${HOOKS_PATH}, so each worktree runs its own hooks.`,
    );
    return;
  }
  const other = values.find(({ value }) => value !== HOOKS_PATH);
  if (other) {
    console.log(
      `CoForge git hooks not enabled: core.hooksPath is already "${other.value}" (${other.scope} config); leaving it unchanged.`,
    );
    return;
  }
  if (values.some(({ scope }) => scope === "local")) return;
  git("config", "--local", "core.hooksPath", HOOKS_PATH);
}

/** Each of the repository's worktrees' `.githooks`, symlinks resolved. */
function worktreeHooks(): Set<string> {
  const listed = git("worktree", "list", "--porcelain");
  return new Set(
    (listed?.exitCode === 0 ? listed.stdout : "")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => canonical(join(line.slice("worktree ".length), HOOKS_PATH))),
  );
}

/** An absolute path with symlinks resolved (macOS's `/var` is `/private/var`); anything else, or
 * a path that does not exist, as given. */
function canonical(path: string): string {
  if (!isAbsolute(path)) return path;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (import.meta.main) {
  try {
    install();
  } catch (error) {
    console.log(`CoForge git hooks not enabled: ${error instanceof Error ? error.message : error}`);
  }
}
