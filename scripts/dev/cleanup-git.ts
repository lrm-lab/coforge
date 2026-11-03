// Git commands for `mise run cleanup` (scripts/dev/cleanup-system.ts and cleanup-activity.ts).
import { firstLine, run, type RunOptions } from "./cleanup-exec";

export const MAIN_REF = "refs/remotes/origin/main";

/**
 * The worktree's changed paths, NUL-separated. `--untracked-files=all` overrides a user's
 * `status.showUntrackedFiles=no`; `--no-optional-locks` keeps the read from rewriting the index.
 */
export const STATUS_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain",
  "-z",
  "--untracked-files=all",
];

/** The same listing with ignored entries (`!!`), whose mtimes count as activity too. */
export const ACTIVITY_STATUS_ARGS = [...STATUS_ARGS, "--ignored=matching"];

export const git = (args: string[], cwd: string, options: Omit<RunOptions, "cwd"> = {}) =>
  run(["git", "-c", "core.quotePath=false", ...args], { cwd, ...options });

/** The stdout of a git command that must succeed. */
export async function mustGit(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${firstLine(result.stderr)}`);
  return result.stdout;
}

export async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size)
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  return results;
}
