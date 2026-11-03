// The planning half of `mise run cleanup` (scripts/dev/cleanup.ts): parsers for the output of git,
// ps and lsof, the pure decision of what to remove, and the text that shows it. It touches no
// process, file or repository, so the decision is testable with injected facts.

import { win32 } from "node:path";

/** One entry of `git worktree list --porcelain`. */
export type Worktree = {
  path: string;
  head: string;
  /** The checked-out branch without `refs/heads/`; undefined for a detached HEAD. */
  branch: string | undefined;
  locked: boolean;
  /** Git reports the worktree's directory as missing. */
  prunable: boolean;
};

/** A worktree and what git says about its content. */
export type WorktreeState = Worktree & {
  /** Paths `git status --porcelain --untracked-files=all` lists (ignored files do not count). */
  changedFiles: number;
  /** Commits of HEAD that have a patch-equivalent commit on origin/main (`-` in `git cherry`). */
  onMain: number;
  /** Commits of HEAD that do not (`+` in `git cherry`). */
  notOnMain: number;
  /** Merge commits between origin/main and HEAD, which `git cherry` does not cover. */
  hasMerges: boolean;
  /** Its HEAD reflog shows a commit made in it, or it holds commits with an equivalent on main. */
  madeCommits: boolean;
  /** Epoch milliseconds of the newest HEAD reflog entry or index write; undefined when unknown. */
  lastActivityMs: number | undefined;
  /** Detached HEAD only: commits made in it that the reflog alone still holds and main lacks. */
  reflogOnlyCommits: number;
  /** Reading the worktree failed; it is kept with this as the reason. */
  error?: string;
};

/** A process of the current user with its working directory. */
export type ProcessInfo = {
  pid: number;
  command: string;
  cwd: string;
  /** Whether the directory is there now (an `access` check). A path recreated after the process
   * lost its directory reads as existing, which errs toward keeping the worktree. */
  cwdExists: boolean;
};

export type Plan = {
  mainPath: string;
  /** `forced`: stale, so removed with `--force` and its work lost; `why` says what is lost. */
  remove: { worktree: WorktreeState; why: string; forced: boolean }[];
  /** `busy`: a live process runs inside it, which is worth telling the user to stop. */
  keep: { worktree: WorktreeState; reasons: string[]; busy: boolean }[];
  orphans: ProcessInfo[];
  platform: string;
  /** Set when every worktree looks idle at once, so no stale removal is planned. */
  clockNote?: string;
  /** Why no worktree may be removed: the live-process check could not run. */
  blocked?: string;
};

/** A worktree that never committed is left alone this long after its last activity. */
export const DEFAULT_IDLE_HOURS = 24;

/** A worktree idle this long is removed whatever its state: its work is lost. */
export const STALE_DAYS = 7;

/** No worktree is removed sooner than this after its last activity: someone may be working in it. */
export const MIN_QUIET_HOURS = 1;

export type PlanInput = {
  mainPath: string;
  worktrees: WorktreeState[];
  processes: ProcessInfo[];
  /** Epoch milliseconds the idle time is measured to. */
  now: number;
  idleHours?: number;
  staleDays?: number;
  /** The newest timestamp seen anywhere in the repository; undefined when unknown. */
  newestSeenMs?: number;
  /** The directory the command runs in; the worktree holding it is never removed. */
  currentDirectory?: string;
  /** Set when the processes could not be listed; nothing removes a worktree. */
  processDiscoveryError?: string;
  /** `process.platform` unless a test says otherwise; on win32 a worktree's use is probed at apply. */
  platform?: string;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Reflog subjects of HEAD movements that create a commit in the worktree. Creating, `reset`,
// `checkout`, a fast-forward `merge` and `rebase (start|finish)` move HEAD without authoring one.
const COMMITTING_SUBJECT =
  /^(commit\b|cherry-pick\b|revert\b|am\b|rebase \((pick|reword|squash|fixup|edit)\))/;

const DEV_COMMANDS = new Set(["bun", "node"]);

export function parseWorktreeList(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const record of porcelain.split(/\n\s*\n/)) {
    const lines = record.split("\n").filter(Boolean);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) continue;
    const field = (name: string) =>
      lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
    const flag = (name: string) =>
      lines.some((line) => line === name || line.startsWith(`${name} `));
    worktrees.push({
      path,
      head: field("HEAD") ?? "",
      branch: field("branch")?.replace(/^refs\/heads\//, ""),
      locked: flag("locked"),
      prunable: flag("prunable"),
    });
  }
  return worktrees;
}

/** `git cherry <upstream> <head>`: `-` lines have an equivalent on upstream, `+` lines do not. */
export function parseCherry(output: string): { onMain: number; notOnMain: number } {
  let onMain = 0;
  let notOnMain = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("- ")) onMain++;
    else if (line.startsWith("+ ")) notOnMain++;
  }
  return { onMain, notOnMain };
}

export type StatusEntry = { path: string; ignored: boolean };

/** `git status --porcelain -z --ignored=matching`: each entry once (a rename's source is skipped). */
export function parseStatus(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const fields = output.split("\0").filter(Boolean);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    entries.push({ path: field.slice(3), ignored: field.startsWith("!!") });
    if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") index++;
  }
  return entries;
}

/** `git ls-files -v -z`: the files hidden from `git status` by assume-unchanged or skip-worktree. */
export function parseHiddenFiles(output: string): string[] {
  return output
    .split("\0")
    .filter((field) => field.length > 2)
    .filter((field) => field[0] === "S" || field[0] !== field[0]!.toUpperCase())
    .map((field) => field.slice(2));
}

/**
 * `git reflog show HEAD --date=unix --format='%gd|%H|%gs'`, newest first: when HEAD last moved, and
 * the commits it reached by making one (`committed`, each once).
 */
export function parseReflog(output: string): {
  committed: string[];
  lastActivityMs: number | undefined;
} {
  const committed = new Set<string>();
  let lastSeconds: number | undefined;
  for (const line of output.split("\n")) {
    const match = /^HEAD@\{(\d+)\}\|([0-9a-f]{40,64})\|(.*)$/.exec(line);
    if (!match) continue;
    lastSeconds = Math.max(lastSeconds ?? 0, Number(match[1]));
    if (COMMITTING_SUBJECT.test(match[3]!)) committed.add(match[2]!);
  }
  return {
    committed: [...committed],
    lastActivityMs: lastSeconds === undefined ? undefined : lastSeconds * 1000,
  };
}

/** `ps -x -o pid=,command=`: each pid's command line. */
export function parseProcessTable(listing: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!.trim());
  }
  return commands;
}

/** Whether a command line runs `bun` or `node`, which is what the repository's dev helpers run. */
export function isDevCommand(command: string): boolean {
  return DEV_COMMANDS.has(command.trim().split(/\s+/)[0]!.split("/").pop()!);
}

/** `lsof -a -d cwd -Fpcn`: the command name and working directory of each pid. */
export function parseLsofCwd(output: string): Map<number, { name: string; cwd: string }> {
  const processes = new Map<number, { name: string; cwd: string }>();
  let pid: number | undefined;
  let name = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      name = "";
    } else if (line.startsWith("c")) name = line.slice(1);
    else if (line.startsWith("n") && pid !== undefined && !processes.has(pid))
      processes.set(pid, { name, cwd: line.slice(1) });
  }
  return processes;
}

/**
 * A path in the form two paths are compared in. Git prints `C:/Repo/x` and Bun reports `C:\\repo\\x`
 * for the same Windows directory, which is case-insensitive; elsewhere a path is compared as is.
 */
export function normalizePath(path: string, platform: string = process.platform): string {
  if (platform !== "win32") return path;
  return win32.resolve(path).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
}

export function isInside(path: string, root: string, platform: string = process.platform) {
  const inner = normalizePath(path, platform);
  const outer = normalizePath(root, platform);
  return inner === outer || inner.startsWith(`${outer}/`);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function formatAge(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours >= 48 ? plural(Math.floor(hours / 24), "day") : plural(hours, "hour");
}

/**
 * Why a worktree cannot be removed, or none. It holds back one with uncommitted changes, commits
 * (or merges, or reflog-only commits of a detached HEAD) that main lacks, a live process or the
 * caller's current directory, and one active within `MIN_QUIET_HOURS`. A worktree that never
 * committed anything (just created, work not started) waits for `idleHours` instead.
 */
function keepReasons(
  worktree: WorktreeState,
  input: PlanInput,
  idle: number | undefined,
  never: boolean,
): { reasons: string[]; busy: boolean; hard: boolean } {
  const reasons: string[] = [];
  const busyWith = input.processes.filter(
    (process) => process.cwdExists && isInside(process.cwd, worktree.path, input.platform),
  );
  if (worktree.error) reasons.push(`could not inspect it (${worktree.error})`);
  if (worktree.locked) reasons.push("locked");
  if (worktree.changedFiles > 0) reasons.push("uncommitted changes");
  if (worktree.notOnMain > 0)
    reasons.push(
      `not on main (${plural(worktree.notOnMain, "commit")} without an equivalent on origin/main; a squash merge of several commits is not detected)`,
    );
  if (worktree.hasMerges) reasons.push("has merge commits not on main");
  if (worktree.reflogOnlyCommits > 0)
    reasons.push(
      `commits only in its reflog (${plural(worktree.reflogOnlyCommits, "commit")} made on a detached HEAD, not on origin/main)`,
    );
  if (worktree.prunable && !worktree.branch)
    reasons.push("directory is missing and HEAD is detached; its reflog cannot be checked");
  for (const process of busyWith)
    reasons.push(`process running (pid ${process.pid}, ${process.command})`);
  const current = input.currentDirectory;
  if (current !== undefined && isInside(current, worktree.path, input.platform))
    reasons.push("the command runs inside it");

  // Nothing overrides these, however stale the worktree is.
  const hard =
    worktree.locked ||
    busyWith.length > 0 ||
    reasons.includes("the command runs inside it") ||
    !!worktree.error;
  if (reasons.length > 0 || worktree.prunable) return { reasons, busy: busyWith.length > 0, hard };
  const idleLimit = (input.idleHours ?? DEFAULT_IDLE_HOURS) * HOUR_MS;
  if (idle === undefined) reasons.push("last activity unknown");
  else if (never && idle < idleLimit)
    reasons.push(`new worktree, no commits yet (last activity ${formatAge(idle)} ago)`);
  else if (idle < MIN_QUIET_HOURS * HOUR_MS)
    reasons.push(`recently active (last activity ${formatAge(idle)} ago)`);
  return { reasons, busy: false, hard };
}

const listOf = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** What removing a stale worktree loses, in plain words; none when everything is on main. */
function lostWork(worktree: WorktreeState): string[] {
  const lost: string[] = [];
  if (worktree.changedFiles > 0) lost.push(plural(worktree.changedFiles, "uncommitted file"));
  if (worktree.notOnMain > 0) lost.push(`${plural(worktree.notOnMain, "commit")} not on main`);
  if (worktree.hasMerges) lost.push("merge commits not on main");
  if (worktree.reflogOnlyCommits > 0)
    lost.push(`${plural(worktree.reflogOnlyCommits, "commit")} only in its reflog`);
  return lost;
}

function removalReason(worktree: WorktreeState, idle: number | undefined, never: boolean) {
  if (worktree.prunable) return "its directory is already gone, and what it held is on origin/main";
  if (never) return `no commits, idle for ${formatAge(idle!)}, no uncommitted changes`;
  if (worktree.onMain === 0) return "its commits are on origin/main, no uncommitted changes";
  return `${plural(worktree.onMain, "commit")}, all on origin/main, no uncommitted changes`;
}

/**
 * Decides what to remove. `worktrees` are the worktrees other than the main checkout. A process is
 * an orphan when it is `bun` or `node`, its directory was removed, and that lay inside the main
 * checkout or one of its worktrees.
 */
export function planCleanup(input: PlanInput): Plan {
  const remove: Plan["remove"] = [];
  const keep: Plan["keep"] = [];
  const staleLimit = Math.max((input.staleDays ?? STALE_DAYS) * DAY_MS, MIN_QUIET_HOURS * HOUR_MS);
  // Everything idle at once, with nothing recent anywhere (not even a fetch), is more likely a
  // clock that jumped forward than a week of nobody working: do not delete work on that evidence.
  const sinceNewest = input.newestSeenMs === undefined ? 0 : input.now - input.newestSeenMs;
  const clockSuspect = sinceNewest > DAY_MS && sinceNewest >= staleLimit;

  for (const worktree of input.worktrees) {
    // A prunable worktree has no directory left to hold work, so it cannot be a new one.
    const never = !worktree.prunable && !worktree.madeCommits && worktree.onMain === 0;
    const idle =
      worktree.lastActivityMs === undefined ? undefined : input.now - worktree.lastActivityMs;
    const { reasons, busy, hard } = keepReasons(worktree, input, idle, never);
    const lost = lostWork(worktree);
    const stale =
      !hard && !worktree.prunable && idle !== undefined && idle >= staleLimit && lost.length > 0;
    if (stale && !clockSuspect)
      remove.push({
        worktree,
        why: `idle ${formatAge(idle!)} \u2014 removed with ${listOf(lost)} (lost)`,
        forced: true,
      });
    else {
      if (stale)
        reasons.push(
          `idle ${formatAge(idle!)}, but every worktree looks idle; check the system clock`,
        );
      if (reasons.length > 0) keep.push({ worktree, reasons, busy });
      else remove.push({ worktree, why: removalReason(worktree, idle, never), forced: false });
    }
  }

  const roots = [input.mainPath, ...input.worktrees.map((worktree) => worktree.path)];
  const orphans = input.processes.filter(
    (process) =>
      !process.cwdExists &&
      isDevCommand(process.command) &&
      roots.some((root) => isInside(process.cwd, root, input.platform)),
  );
  return {
    mainPath: input.mainPath,
    remove,
    keep,
    orphans,
    platform: input.platform ?? process.platform,
    clockNote: clockSuspect
      ? `Every worktree looks idle: the newest activity in the repository is ${formatAge(sinceNewest)} old. Check the system clock; no worktree is removed for being stale.`
      : undefined,
    blocked: input.processDiscoveryError,
  };
}

const describeWorktree = (worktree: Worktree) =>
  `${worktree.path}  [${worktree.branch ?? "detached HEAD"}]`;

export function formatPlan(plan: Plan): string {
  if (plan.remove.length + plan.keep.length + plan.orphans.length === 0)
    return "Nothing to clean up: no other worktrees and no orphan processes.";
  const sections: string[] = [];

  sections.push(
    [
      `Worktrees to remove (${plan.remove.length})`,
      ...plan.remove.map(
        (entry) =>
          `  ${describeWorktree(entry.worktree)}\n    ${entry.why}${plan.platform === "win32" && !entry.worktree.prunable ? "\n    will be checked for use before removal" : ""}`,
      ),
      ...(plan.remove.length > 0
        ? [
            "  Removing a worktree also deletes its ignored files (.env, copied infra/secrets, local data).",
          ]
        : []),
    ].join("\n"),
  );

  const keptLines = [`Worktrees kept (${plan.keep.length})`];
  for (const entry of plan.keep)
    keptLines.push(
      `  ${describeWorktree(entry.worktree)}`,
      ...entry.reasons.map((reason) => `    ${reason}`),
    );
  if (plan.keep.some((entry) => entry.busy))
    keptLines.push("  A live process inside a worktree keeps that worktree; stop it to clean up.");
  sections.push(keptLines.join("\n"));

  sections.push(
    plan.platform === "win32"
      ? "Orphan processes: not applicable on Windows. A directory in use cannot be deleted there, so no process can be left in a removed one."
      : [
          `Orphan processes (${plan.orphans.length})`,
          ...plan.orphans.map(
            (process) =>
              `  pid ${process.pid}  ${process.command}\n    missing cwd: ${process.cwd}`,
          ),
        ].join("\n"),
  );
  if (plan.clockNote) sections.push(plan.clockNote);
  if (plan.blocked)
    sections.push(
      `Cannot check for live processes (${plan.blocked}).\n  No worktree will be removed until it can.`,
    );
  return sections.join("\n\n");
}
