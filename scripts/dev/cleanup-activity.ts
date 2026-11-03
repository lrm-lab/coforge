// When a worktree was last used, for `mise run cleanup` (scripts/dev/cleanup-system.ts): the newest
// of its HEAD reflog, its index and the mtime of everything that can show use without a commit or
// a stage: every file `git status` lists (ignored ones too), the directory each sits in (a file
// moved in keeps its old mtime but changes its directory's), the top level of an ignored
// directory, and the files `--skip-worktree` or `--assume-unchanged` hide from status.
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ACTIVITY_STATUS_ARGS, git, inBatches, mustGit } from "./cleanup-git";
import { parseHiddenFiles, parseReflog, parseStatus } from "./cleanup-plan";

const STAT_BATCH = 64;
/** An ignored directory such as node_modules is read one level deep, never walked. */
const IGNORED_DIRECTORY_LIMIT = 5000;

/** The mtime of a file, or undefined when it is not there. */
export async function fileTime(path: string): Promise<number | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.lastModified : undefined;
}

/** The mtime of the worktree's index, which a worktree in use keeps writing. */
export async function indexTime(path: string): Promise<number | undefined> {
  const index = await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], path);
  return index.ok ? fileTime(index.stdout.trim()) : undefined;
}

async function mtimeOf(path: string): Promise<number | undefined> {
  return lstat(path).then(
    (info) => info.mtimeMs,
    () => undefined,
  );
}

/**
 * The mtime of a path; for a deleted one, of the nearest directory above it that exists (the
 * delete touched it). An unreadable path is skipped.
 */
async function editTime(root: string, relative: string): Promise<number | undefined> {
  let current = join(root, relative);
  for (;;) {
    try {
      return (await lstat(current)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === root) return undefined;
      current = dirname(current);
      if (current.length < root.length) return undefined;
    }
  }
}

/** An ignored directory's own mtime and that of its top-level entries. */
async function ignoredDirectoryTimes(root: string, relative: string): Promise<number[]> {
  const directory = join(root, relative);
  const own = await mtimeOf(directory);
  const names = await readdir(directory).catch(() => [] as string[]);
  const inside = await inBatches(names.slice(0, IGNORED_DIRECTORY_LIMIT), STAT_BATCH, (name) =>
    mtimeOf(join(directory, name)),
  );
  return [own, ...inside].filter((time) => time !== undefined);
}

export type Activity = {
  lastActivityMs: number | undefined;
  /** Commits HEAD reached by committing, newest first. */
  committed: string[];
  /** Paths `git status` lists, ignored ones not counted. */
  changedFiles: number;
};

/** Reads a worktree's activity; the index time is read before `git status` can touch it. */
export async function readActivity(path: string): Promise<Activity> {
  const touched = await indexTime(path);
  const reflog = parseReflog(
    await mustGit(["reflog", "show", "HEAD", "--date=unix", "--format=%gd|%H|%gs"], path),
  );
  const entries = parseStatus(await mustGit(ACTIVITY_STATUS_ARGS, path));
  const hidden = parseHiddenFiles(await mustGit(["ls-files", "-v", "-z"], path));
  const listed = entries.filter((entry) => !entry.ignored).map((entry) => entry.path);
  const ignored = entries.filter((entry) => entry.ignored).map((entry) => entry.path);
  const directories = new Set(entries.map((entry) => dirname(entry.path)));

  const times = [
    reflog.lastActivityMs,
    touched,
    ...(await inBatches(listed, STAT_BATCH, (file) => editTime(path, file))),
    ...(await inBatches(
      ignored.filter((file) => !file.endsWith("/")),
      STAT_BATCH,
      (file) => mtimeOf(join(path, file)),
    )),
    ...(
      await inBatches(
        ignored.filter((file) => file.endsWith("/")),
        STAT_BATCH,
        (directory) => ignoredDirectoryTimes(path, directory),
      )
    ).flat(),
    ...(await inBatches([...directories], STAT_BATCH, (directory) =>
      mtimeOf(join(path, directory)),
    )),
    ...(await inBatches(hidden, STAT_BATCH, (file) => mtimeOf(join(path, file)))),
  ].filter((time) => time !== undefined);
  return {
    lastActivityMs: times.length === 0 ? undefined : Math.max(...times),
    committed: reflog.committed,
    changedFiles: listed.length,
  };
}
