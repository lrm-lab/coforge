import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const HOOKS_PATH = ".githooks";
const REPO_HOOKS_DIR = canonicalPath(resolve(import.meta.dir, "../../.githooks"));

export type HooksPathCheck = { ok: true } | { ok: false; error: string };

function git(cwd: string, ...args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

/** `path` with symlinks resolved, as far as it exists. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

/**
 * Verifies that `core.hooksPath` in `top` points to `top/.githooks` (not unset, not another
 * worktree's `.githooks`, and not a custom directory). `command`-scope entries from `GIT_CONFIG_*`
 * or `-c` are ignored because they come from Agent wrapper shims that forward to the repo config.
 */
export function checkRepoHooksPath(top: string): HooksPathCheck {
  const configured = git(
    top,
    "config",
    "--type=path",
    "--show-scope",
    "--get-all",
    "core.hooksPath",
  );
  const values = (configured.exitCode === 0 ? configured.stdout : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [scope, ...value] = line.split("\t");
      return { scope, value: value.join("\t") };
    })
    .filter(({ scope }) => scope !== "command");
  const effective = values.at(-1)?.value;
  if (effective === undefined) {
    return {
      ok: false,
      error:
        "git hooks are not installed (core.hooksPath is unset): run `git config --local core.hooksPath .githooks` or `bun install`",
    };
  }
  const expected = resolve(top, HOOKS_PATH);
  const effectivePath = canonicalPath(resolve(top, effective));
  const matchesWorktree = effectivePath === canonicalPath(expected);
  const matchesSharedFixture = !existsSync(expected) && effectivePath === REPO_HOOKS_DIR;
  if (!matchesWorktree && !matchesSharedFixture) {
    return {
      ok: false,
      error: `core.hooksPath is "${effective}", not "${HOOKS_PATH}": run \`git config --local core.hooksPath .githooks\` or \`bun install\``,
    };
  }
  return { ok: true };
}

if (import.meta.main) {
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (top.exitCode !== 0 || !top.stdout) process.exit(0);
  const check = checkRepoHooksPath(top.stdout);
  if (!check.ok) {
    console.error(`git-hooks: ${check.error}`);
    process.exit(1);
  }
}
