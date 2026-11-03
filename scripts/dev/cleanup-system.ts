// The side-effecting half of `mise run cleanup` (scripts/dev/cleanup.ts): it reads the repository
// and the process table into the facts scripts/dev/cleanup-plan.ts decides on, and carries out a
// plan. Every git command runs in the main checkout, which outlives the worktrees removed here.
import { fileTime, indexTime, readActivity } from "./cleanup-activity";
import { commandOf, discoverProcesses, type DiscoveryOptions } from "./cleanup-discovery";
import { probeInUse, type Rename, type SignalHooks } from "./cleanup-windows";
import { firstLine, run, type Runner } from "./cleanup-exec";
import { git, inBatches, MAIN_REF, mustGit, STATUS_ARGS } from "./cleanup-git";
import {
  isInside,
  parseCherry,
  parseWorktreeList,
  type Plan,
  type ProcessInfo,
  type Worktree,
  type WorktreeState,
} from "./cleanup-plan";

export const FETCH_TIMEOUT_MILLISECONDS = 30_000;
const TERMINATE_WAIT_MILLISECONDS = 3000;
const TERMINATE_POLL_MILLISECONDS = 100;
/** Branches that are never deleted, whatever their commits. */
const PROTECTED_BRANCHES = ["main", "master"];

/** What git says about one worktree; a failure of any command is kept as the worktree's error. */
async function inspect(worktree: Worktree, mainPath: string): Promise<WorktreeState> {
  const state: WorktreeState = {
    ...worktree,
    changedFiles: 0,
    onMain: 0,
    notOnMain: 0,
    hasMerges: false,
    madeCommits: false,
    lastActivityMs: undefined,
    reflogOnlyCommits: 0,
  };
  try {
    let committed: string[] = [];
    if (!worktree.prunable) {
      const activity = await readActivity(worktree.path);
      committed = activity.committed;
      state.lastActivityMs = activity.lastActivityMs;
      state.changedFiles = activity.changedFiles;
    }
    Object.assign(state, parseCherry(await mustGit(["cherry", MAIN_REF, worktree.head], mainPath)));
    const merges = await mustGit(
      ["rev-list", "--merges", `${MAIN_REF}..${worktree.head}`],
      mainPath,
    );
    state.hasMerges = merges.trim() !== "";
    state.madeCommits = committed.length > 0 || state.onMain > 0;
    // A branch keeps its commits reachable after the worktree is gone; a detached HEAD does not.
    if (!worktree.branch && state.notOnMain === 0)
      for (const sha of committed)
        if (parseCherry(await mustGit(["cherry", MAIN_REF, sha], mainPath)).notOnMain > 0)
          state.reflogOnlyCommits++;
  } catch (error) {
    state.error = (error as Error).message;
  }
  return state;
}

export type GatherOptions = DiscoveryOptions & {
  /** Any directory of the repository; git runs here first. */
  cwd: string;
  /** The directory the user ran the command from, whose worktree is never removed; `cwd` if unset. */
  currentDirectory?: string;
  fetch: boolean;
  /** Replaces the process scan when given. */
  processes?: ProcessInfo[];
  /** Runs `git fetch` and the process scan; tests inject one that cannot reach the network. */
  run?: Runner;
};

/**
 * Reads the main checkout, every other worktree's state against origin/main, and the processes.
 * When the process scan fails, `processDiscoveryError` says why and `processes` is empty.
 */
export async function gatherState(options: GatherOptions): Promise<{
  mainPath: string;
  worktrees: WorktreeState[];
  processes: ProcessInfo[];
  currentDirectory: string;
  warnings: string[];
  processDiscoveryError?: string;
  platform: string;
  /** The newest timestamp seen anywhere in the repository, for the clock check. */
  newestSeenMs: number | undefined;
}> {
  const warnings: string[] = [];
  const listed = await git(["worktree", "list", "--porcelain"], options.cwd);
  if (!listed.ok) throw new Error(`git worktree list failed: ${firstLine(listed.stderr)}`);
  const [main, ...others] = parseWorktreeList(listed.stdout);
  if (main === undefined) throw new Error("git lists no worktree");
  const mainPath = main.path;
  const exec = options.run ?? run;

  let fetchedOk = false;
  if (options.fetch) {
    const fetched = await exec(["git", "fetch", "--quiet", "origin", "main"], {
      cwd: mainPath,
      env: { ...(Bun.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" },
      timeout: FETCH_TIMEOUT_MILLISECONDS,
    });
    fetchedOk = fetched.ok;
    if (!fetched.ok)
      warnings.push(
        `could not fetch origin main (${fetched.timedOut ? `timed out after ${FETCH_TIMEOUT_MILLISECONDS / 1000} s` : firstLine(fetched.stderr)}); using the last known origin/main, which can only keep more worktrees`,
      );
  }
  if (!(await git(["rev-parse", "--verify", "--quiet", MAIN_REF], mainPath)).ok)
    throw new Error("origin/main does not exist; fetch it first");

  const worktrees = await inBatches(others, 8, (worktree) => inspect(worktree, mainPath));

  let processes = options.processes ?? [];
  let processDiscoveryError: string | undefined;
  if (options.processes === undefined)
    try {
      processes = await discoverProcesses([mainPath, ...others.map((worktree) => worktree.path)], {
        platform: options.platform,
        procRoot: options.procRoot,
        run: options.run,
      });
    } catch (error) {
      processDiscoveryError = (error as Error).message;
    }
  // What a clock that jumped forward cannot fake: the main checkout's index and, after a fetch,
  // the time the fetch just wrote.
  const fetchHead = await git(
    ["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"],
    mainPath,
  );
  const seen = [
    ...worktrees.map((worktree) => worktree.lastActivityMs),
    await indexTime(mainPath),
    fetchedOk && fetchHead.ok ? await fileTime(fetchHead.stdout.trim()) : undefined,
  ].filter((time) => time !== undefined);
  return {
    mainPath,
    worktrees,
    processes,
    currentDirectory: options.currentDirectory ?? options.cwd,
    warnings,
    processDiscoveryError,
    platform: options.platform ?? process.platform,
    newestSeenMs: seen.length === 0 ? undefined : Math.max(...seen),
  };
}

export type ProcessOps = {
  kill: (pid: number) => void;
  isAlive: (pid: number) => boolean;
  /** The pid's command line now; undefined when the process is gone. */
  commandOf: (pid: number) => string | undefined | Promise<string | undefined>;
  waitMilliseconds?: number;
};

const systemProcessOps: ProcessOps = {
  kill: (pid) => process.kill(pid, "SIGTERM"),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  commandOf: (pid) => commandOf(pid),
};

export type ApplyOverrides = Partial<ProcessOps> & {
  rename?: Rename;
  signals?: SignalHooks;
  /** Runs after a branch is verified and before it is deleted; tests move the branch here. */
  beforeBranchDelete?: (branch: string) => Promise<void>;
  /** Lists the processes again before the first stale removal; the platform's scan by default. */
  rediscover?: () => Promise<ProcessInfo[]>;
};

/** One more look at the processes, once, right before work is thrown away. */
async function rediscoverProcesses(
  plan: Plan,
  worktrees: string[],
  overrides: ApplyOverrides,
): Promise<ProcessInfo[] | Error> {
  try {
    return await (overrides.rediscover?.() ??
      discoverProcesses([plan.mainPath, ...worktrees], { platform: plan.platform }));
  } catch (error) {
    return error as Error;
  }
}

export type StepResult = { step: string; ok: boolean; detail?: string };

/**
 * Sends SIGTERM to each orphan whose command line is still the planned one, waits briefly, and
 * reports the survivors. Never sends SIGKILL.
 */
async function terminateOrphans(orphans: ProcessInfo[], ops: ProcessOps): Promise<StepResult[]> {
  const results = new Map<number, StepResult>();
  const signalled: ProcessInfo[] = [];
  const stepOf = (orphan: ProcessInfo) => `terminate pid ${orphan.pid} (${orphan.command})`;
  for (const orphan of orphans) {
    let now: string | undefined;
    try {
      now = await ops.commandOf(orphan.pid);
    } catch (error) {
      results.set(orphan.pid, {
        step: stepOf(orphan),
        ok: false,
        detail: `skipped, its command line could not be read: ${(error as Error).message}`,
      });
      continue;
    }
    if (now === undefined)
      results.set(orphan.pid, { step: stepOf(orphan), ok: true, detail: "already gone" });
    else if (now !== orphan.command)
      results.set(orphan.pid, {
        step: stepOf(orphan),
        ok: false,
        detail: `skipped, the pid now runs a different command: ${now}`,
      });
    else {
      try {
        ops.kill(orphan.pid);
        signalled.push(orphan);
      } catch (error) {
        results.set(orphan.pid, {
          step: stepOf(orphan),
          ok: false,
          detail: (error as Error).message,
        });
      }
    }
  }
  const wait = ops.waitMilliseconds ?? TERMINATE_WAIT_MILLISECONDS;
  let alive = signalled.filter(({ pid }) => ops.isAlive(pid));
  for (let waited = 0; alive.length > 0 && waited < wait; waited += TERMINATE_POLL_MILLISECONDS) {
    await Bun.sleep(TERMINATE_POLL_MILLISECONDS);
    alive = alive.filter(({ pid }) => ops.isAlive(pid));
  }
  const survivors = new Set(alive.map(({ pid }) => pid));
  for (const orphan of signalled)
    results.set(orphan.pid, {
      step: stepOf(orphan),
      ok: !survivors.has(orphan.pid),
      detail: survivors.has(orphan.pid) ? "still running after SIGTERM; not killed" : undefined,
    });
  return orphans.map((orphan) => results.get(orphan.pid)!);
}

/**
 * Deletes a removed worktree's branch only when it is not `main`, `master` or the remote's default
 * and no worktree has it checked out, and either its tip is already in origin/main (it holds
 * nothing beyond main) or it holds commits of its own that are all on origin/main, with no merge.
 * The checks run on one commit, and the branch is deleted only if it still points at it.
 */
async function deleteBranch(
  branch: string,
  protectedBranches: Set<string>,
  mainPath: string,
  options: { forced: boolean; beforeDelete?: (branch: string) => Promise<void> },
): Promise<StepResult> {
  const keep = (detail: string): StepResult => ({
    step: `keep branch ${branch}`,
    ok: true,
    detail,
  });
  if (protectedBranches.has(branch)) return keep("protected branch");
  const ref = `refs/heads/${branch}`;
  const resolved = await git(["rev-parse", "--verify", "--quiet", ref], mainPath);
  if (!resolved.ok) return keep("already gone");
  const tip = resolved.stdout.trim();
  const listed = await git(["worktree", "list", "--porcelain"], mainPath);
  if (parseWorktreeList(listed.stdout).some((worktree) => worktree.branch === branch))
    return keep("checked out elsewhere");
  // A stale worktree's branch goes with it, whatever is on it; the checks above still apply.
  const ancestor = options.forced
    ? { ok: true }
    : await git(["merge-base", "--is-ancestor", tip, MAIN_REF], mainPath);
  if (!ancestor.ok) {
    const cherry = await git(["cherry", MAIN_REF, tip], mainPath);
    const merges = await git(["rev-list", "--merges", `${MAIN_REF}..${tip}`], mainPath);
    if (!cherry.ok || !merges.ok) return keep("could not compare it with origin/main");
    if (parseCherry(cherry.stdout).notOnMain > 0 || merges.stdout.trim() !== "")
      return keep("has commits without an equivalent on origin/main");
  }
  await options.beforeDelete?.(branch);
  const deleted = await git(["update-ref", "-d", ref, tip], mainPath);
  if (!deleted.ok) {
    const now = await git(["rev-parse", "--verify", "--quiet", ref], mainPath);
    if (now.ok && now.stdout.trim() !== tip) return keep("moved while it was checked");
    return { step: `delete branch ${branch}`, ok: false, detail: firstLine(deleted.stderr) };
  }
  // `git branch -D` also drops the branch's tracking section; update-ref does not.
  await git(["config", "--remove-section", `branch.${branch}`], mainPath);
  return { step: `delete branch ${branch}`, ok: true };
}

/**
 * Carries out a plan: stops the orphan processes first, then removes each worktree without
 * `--force` (git refuses one with changes) and only if its HEAD is still the planned one, then
 * deletes the branches that qualify. `git worktree remove` also drops the record of a worktree
 * whose directory is already gone, so nothing is pruned.
 */
export async function applyPlan(plan: Plan, overrides: ApplyOverrides = {}): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const gone: { worktree: WorktreeState; forced: boolean }[] = [];
  const worktrees = plan.remove.map((entry) => entry.worktree.path);
  let live: ProcessInfo[] | Error | undefined;

  // Without the live-process check a worktree under someone's shell could be removed.
  if (plan.blocked)
    return plan.remove.length === 0
      ? []
      : [{ step: "remove worktrees", ok: false, detail: `refused, ${plan.blocked}` }];

  if (plan.orphans.length > 0)
    results.push(...(await terminateOrphans(plan.orphans, { ...systemProcessOps, ...overrides })));

  for (const { worktree, forced } of plan.remove) {
    const step = `remove ${worktree.path}`;
    if (!worktree.prunable) {
      const head = await git(["rev-parse", "HEAD"], worktree.path);
      const current = head.ok ? head.stdout.trim() : undefined;
      if (current !== worktree.head) {
        results.push({
          step,
          ok: false,
          detail: `kept, changed since the plan (HEAD was ${worktree.head.slice(0, 9)}, now ${current?.slice(0, 9) ?? "unreadable"})`,
        });
        continue;
      }
      if (forced) {
        // A stale worktree is removed with its work, so it must still be as idle as when planned,
        // with nobody in it now.
        live ??= await rediscoverProcesses(plan, worktrees, overrides);
        const occupied =
          live instanceof Error
            ? undefined
            : live.find(
                (process) =>
                  process.cwdExists && isInside(process.cwd, worktree.path, plan.platform),
              );
        if (live instanceof Error || occupied) {
          results.push({
            step,
            ok: occupied !== undefined,
            detail:
              live instanceof Error
                ? `kept, could not look for processes again: ${live.message}`
                : `kept, in use since the plan (pid ${occupied!.pid}, ${occupied!.command})`,
          });
          continue;
        }
        const activity = await readActivity(worktree.path).catch(() => undefined);
        if (
          activity?.lastActivityMs === undefined ||
          activity.lastActivityMs > (worktree.lastActivityMs ?? 0)
        ) {
          results.push({ step, ok: false, detail: "kept, changed since the plan (new activity)" });
          continue;
        }
      } else {
        // `git worktree remove` honours `status.showUntrackedFiles=no` and would delete such files.
        const status = await git(STATUS_ARGS, worktree.path);
        if (!status.ok || status.stdout.trim() !== "") {
          results.push({
            step,
            ok: false,
            detail: "kept, changed since the plan (uncommitted changes)",
          });
          continue;
        }
      }
    }
    if (plan.platform === "win32" && !worktree.prunable) {
      const probe = await probeInUse(worktree.path, {
        move: overrides.rename,
        signals: overrides.signals,
      });
      if (probe.state === "stuck") {
        results.push({ step, ok: false, detail: probe.detail });
        return results;
      }
      if (probe.state !== "free") {
        results.push({
          step,
          ok: probe.state === "in use",
          detail:
            probe.state === "in use"
              ? "kept, in use (Windows refused to move it)"
              : `kept, ${probe.detail}`,
        });
        continue;
      }
    }
    const removed = await git(
      ["worktree", "remove", ...(forced ? ["--force"] : []), worktree.path],
      plan.mainPath,
    );
    results.push({
      step,
      ok: removed.ok,
      detail: removed.ok ? undefined : `kept, git refused: ${firstLine(removed.stderr)}`,
    });
    if (removed.ok) gone.push({ worktree, forced });
  }

  const protectedBranches = new Set(PROTECTED_BRANCHES);
  const pointer = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], plan.mainPath);
  if (pointer.ok) protectedBranches.add(pointer.stdout.trim().replace(/^origin\//, ""));
  for (const { worktree, forced } of gone)
    if (worktree.branch !== undefined)
      results.push(
        await deleteBranch(worktree.branch, protectedBranches, plan.mainPath, {
          forced,
          beforeDelete: overrides.beforeBranchDelete,
        }),
      );
  return results;
}
