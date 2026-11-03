// Shared fixtures for the `mise run cleanup` tests: real temporary git repositories.
import { test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planCleanup } from "./cleanup-plan";
import {
  applyPlan,
  FETCH_TIMEOUT_MILLISECONDS,
  gatherState,
  type GatherOptions,
} from "./cleanup-system";

export const HOUR = 3_600_000;

/**
 * A real-git test builds a repository with a couple of dozen git commands and ran past bun's 5 s
 * default under parallel load. No step may take longer than the product lets its slowest git
 * command (the fetch) take, so that is the bound for the whole test.
 */
export const REAL_GIT_TEST_TIMEOUT_MILLISECONDS = FETCH_TIMEOUT_MILLISECONDS;

export function gitTest(name: string, body: () => Promise<void>) {
  test(name, body, REAL_GIT_TEST_TIMEOUT_MILLISECONDS);
}

const tempDirs: string[] = [];

/** Removes every directory a fixture created; call it from `afterEach`. */
export async function removeTempDirs() {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

export async function run(cwd: string, ...command: string[]): Promise<string> {
  const child = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (child.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

export async function commitFile(dir: string, name: string, content: string, message: string) {
  await writeFile(join(dir, name), content);
  await run(dir, "git", "add", name);
  await run(dir, "git", "commit", "-q", "-m", message);
}

/** A clone of a bare origin whose main checkout has worktrees in every state of interest. */
export async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "coforge-cleanup-"));
  tempDirs.push(created);
  const root = await realpath(created);
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  await run(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  await run(root, "git", "clone", "-q", origin, main);
  await run(main, "git", "checkout", "-q", "-B", "main");
  // A user's setting that hides untracked files from `git status` must not hide them from us.
  await run(main, "git", "config", "status.showUntrackedFiles", "no");
  await commitFile(main, "base.txt", "base\n", "base");
  await run(main, "git", "push", "-q", "origin", "main");

  const wt = (name: string) => join(main, ".worktrees", name);
  await mkdir(join(main, ".worktrees"));

  // merged: its commit reached main by a fast-forward push.
  await run(main, "git", "worktree", "add", "-q", "-b", "merged", wt("merged"));
  await commitFile(wt("merged"), "merged.txt", "merged\n", "feat: merged");
  await run(wt("merged"), "git", "push", "-q", "origin", "merged:main");

  // rebased: pushed to main after a rebase, so the commit hash differs from the branch's.
  await run(main, "git", "worktree", "add", "-q", "-b", "rebased", wt("rebased"));
  await commitFile(wt("rebased"), "rebased.txt", "rebased\n", "feat: rebased");
  await run(main, "git", "worktree", "add", "-q", "--detach", wt("pusher"), "origin/main");
  await run(wt("pusher"), "git", "cherry-pick", "rebased");
  await run(wt("pusher"), "git", "push", "-q", "origin", "HEAD:main");
  await run(main, "git", "worktree", "remove", wt("pusher"));

  // unmerged: a commit that is only on its branch.
  await run(main, "git", "worktree", "add", "-q", "-b", "unmerged", wt("unmerged"));
  await commitFile(wt("unmerged"), "unmerged.txt", "unmerged\n", "feat: unmerged");

  // dirty: nothing new committed, but an untracked file.
  await run(main, "git", "worktree", "add", "-q", "-b", "dirty", wt("dirty"));
  await writeFile(join(wt("dirty"), "scratch.txt"), "scratch\n");

  // fresh: just created from origin/main, nothing done in it yet.
  await run(main, "git", "worktree", "add", "-q", "-b", "fresh", wt("fresh"), "origin/main");

  return { root, main, wt };
}

export const later = () => Date.now() + 3 * 24 * HOUR;

export async function plan(
  cwd: string,
  options: { now?: number } & Partial<Omit<GatherOptions, "cwd" | "fetch">> = {},
): Promise<ReturnType<typeof planCleanup>> {
  const { now, ...gather } = options;
  // No injected processes unless asked: pass `processes: undefined` to run the real scan.
  const gathered = await gatherState({ cwd, fetch: false, processes: [], ...gather });
  return planCleanup({ ...gathered, now: now ?? later() });
}

export const reasons = (result: ReturnType<typeof planCleanup>) =>
  Object.fromEntries(
    result.keep.map((entry) => [
      entry.worktree.branch ?? entry.worktree.path,
      entry.reasons.join(" | "),
    ]),
  );

export const branchNames = async (main: string) =>
  (await run(main, "git", "branch", "--format=%(refname:short)")).split("\n").sort();

export const failed = (results: Awaited<ReturnType<typeof applyPlan>>) =>
  results.filter((result) => !result.ok);

/**
 * A stand-in for `/proc`: one directory per process with a `cwd` symlink (its target ends in
 * " (deleted)" for a removed directory, as the kernel reports it) and a NUL-separated `cmdline`,
 * and `self`, a link to the pid of the process that is reading. A process with `unreadable` has a
 * `cwd` that cannot be read as a link (the kernel's EACCES for a process of ours it hides); one
 * with neither `cwd` nor `unreadable` has already exited.
 */
export async function procTree(
  processes: {
    pid: number;
    cwd?: string;
    args?: string[];
    unreadable?: boolean;
  }[],
  selfPid: number = process.pid,
): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "coforge-proc-"));
  tempDirs.push(created);
  const root = await realpath(created);
  await mkdir(join(root, "sys"));
  await symlink(String(selfPid), join(root, "self"));
  for (const { pid, cwd, args = [], unreadable } of processes) {
    await mkdir(join(root, String(pid)));
    if (cwd !== undefined) await symlink(cwd, join(root, String(pid), "cwd"));
    if (unreadable) await writeFile(join(root, String(pid), "cwd"), "not a link");
    await writeFile(join(root, String(pid), "cmdline"), args.map((arg) => `${arg}\0`).join(""));
  }
  return root;
}
