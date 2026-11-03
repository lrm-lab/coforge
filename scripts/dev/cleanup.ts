#!/usr/bin/env bun
// `mise run cleanup` removes what a developer leaves behind: worktrees whose change is already on
// origin/main, worktrees idle for a week (whatever they hold: that work is lost), and bun/node
// processes left running in a directory that no longer exists. `mise run cleanup -- --dry-run`
// only lists them. docs/agents/delivery.md says why.
//
// macOS (lsof) and Linux (/proc) find the processes inside a worktree and the orphans left in a
// removed one. Windows cannot read another process's directory, so a removal moves a worktree aside
// and back to see whether Windows refuses (it is in use); there is no orphan cleanup there. On
// another platform, or when the scan fails, no worktree is removed.
//
// usage: bun scripts/dev/cleanup.ts [--dry-run|-n] [--no-fetch] [--idle-hours <n>] [--stale-days <n>]
import { parseArgs } from "node:util";

import {
  DEFAULT_IDLE_HOURS,
  formatPlan,
  MIN_QUIET_HOURS,
  planCleanup,
  STALE_DAYS,
} from "./cleanup-plan";
import { applyPlan, gatherState, type StepResult } from "./cleanup-system";

/** Where the user ran the command: mise runs a task in the config root and keeps the original. */
export function invokedDirectory(
  env: Record<string, string | undefined> = Bun.env,
  cwd: string = process.cwd(),
): string {
  return env.MISE_ORIGINAL_CWD ?? cwd;
}

const USAGE =
  "usage: mise run cleanup [-- --dry-run|-n] [--no-fetch] [--idle-hours <n>] [--stale-days <n>]";

const HELP = `${USAGE}
Removes the worktrees already on origin/main, the worktrees idle for a week (their work is lost)
and the dev processes left in a directory that no longer exists.
  --dry-run, -n     only list what would be removed
  --no-fetch        do not fetch origin main first (a fetch also tells a wrong clock from a quiet week)
  --idle-hours <n>  keep a worktree that never committed until it has been idle n hours (default ${DEFAULT_IDLE_HOURS})
  --stale-days <n>  remove a worktree idle n days whatever it holds (default ${STALE_DAYS}, at least ${MIN_QUIET_HOURS} h)
Every removal also waits ${MIN_QUIET_HOURS} h after the worktree's last activity.`;

/** What a run did, from the steps `applyPlan` reports. */
export function summarize(results: StepResult[]): string {
  const done = (prefix: string) =>
    results.filter(
      (result) => result.step.startsWith(prefix) && result.ok && result.detail === undefined,
    ).length;
  const failed = results.filter((result) => !result.ok).length;
  const [worktrees, branches, processes] = [
    done("remove "),
    done("delete branch "),
    done("terminate "),
  ];
  return `Done: removed ${worktrees} ${worktrees === 1 ? "worktree" : "worktrees"}, deleted ${branches} ${branches === 1 ? "branch" : "branches"}, stopped ${processes} ${processes === 1 ? "process" : "processes"}; ${failed} failed.`;
}

/** What `main` does with the repository and the console; tests replace it. */
export type CleanupIo = {
  gather: typeof gatherState;
  apply: typeof applyPlan;
  cwd: string;
  currentDirectory: string;
  log: (line: string) => void;
  warn: (line: string) => void;
};

const systemIo = (): CleanupIo => ({
  gather: gatherState,
  apply: applyPlan,
  cwd: process.cwd(),
  currentDirectory: invokedDirectory(),
  log: console.log,
  warn: console.error,
});

const toNumber = (text: string | undefined) => (text === undefined ? undefined : Number(text));
const isPositive = (value: number | undefined) =>
  value === undefined || (Number.isFinite(value) && value > 0);

export async function main(argv: string[], io: CleanupIo = systemIo()): Promise<number> {
  let values: {
    "dry-run"?: boolean;
    "no-fetch"?: boolean;
    "idle-hours"?: string;
    "stale-days"?: string;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", short: "n" },
        "no-fetch": { type: "boolean" },
        "idle-hours": { type: "string" },
        "stale-days": { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const idleHours = toNumber(values["idle-hours"]);
  const staleDays = toNumber(values["stale-days"]);
  if (!isPositive(idleHours)) {
    console.error(`--idle-hours must be a positive number\n${USAGE}`);
    return 2;
  }
  if (staleDays !== undefined && !(staleDays * 24 >= MIN_QUIET_HOURS)) {
    console.error(
      `--stale-days must be at least ${(MIN_QUIET_HOURS / 24).toFixed(3)} (${MIN_QUIET_HOURS} h, the quiet period)\n${USAGE}`,
    );
    return 2;
  }
  if (values.help) {
    io.log(HELP);
    return 0;
  }

  const state = await io.gather({
    cwd: io.cwd,
    currentDirectory: io.currentDirectory,
    fetch: !values["no-fetch"],
  });
  for (const warning of state.warnings) io.warn(`warning: ${warning}`);
  const plan = planCleanup({ ...state, now: Date.now(), idleHours, staleDays });
  io.log(formatPlan(plan));

  if (values["dry-run"]) {
    if (plan.remove.length + plan.orphans.length > 0)
      io.log("\nDry run. Nothing was changed; run `mise run cleanup` to do it.");
    return 0;
  }
  if (plan.remove.length + plan.orphans.length === 0) return 0;

  io.log("");
  const results = await io.apply(plan);
  for (const result of results)
    io.log(
      `${result.ok ? "ok    " : "FAILED"} ${result.step}${result.detail ? `: ${result.detail}` : ""}`,
    );
  io.log(`\n${summarize(results)}`);
  return results.some((result) => !result.ok) ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: Error) => {
    console.error(`cleanup failed: ${error.message}`);
    return 1;
  });
}
