#!/usr/bin/env bun
// `mise run cleanup` lists what a developer can clean up after a change: worktrees whose change is
// already on origin/main, and bun/node processes left running in a directory that no longer exists.
// `mise run cleanup -- --apply` does it. docs/agents/delivery.md says why.
//
// macOS (lsof) and Linux (/proc) find the processes inside a worktree and the orphans left in a
// removed one. Windows cannot read another process's directory, so --apply moves a worktree aside
// and back to see whether Windows refuses (it is in use); there is no orphan cleanup there. On
// another platform, or when the scan fails, --apply removes no worktree.
//
// usage: bun scripts/dev/cleanup.ts [--apply] [--no-fetch] [--idle-hours <n>]
import { parseArgs } from "node:util";

import { DEFAULT_IDLE_HOURS, formatPlan, MIN_QUIET_HOURS, planCleanup } from "./cleanup-plan";
import { applyPlan, gatherState } from "./cleanup-system";

/** Where the user ran the command: mise runs a task in the config root and keeps the original. */
export function invokedDirectory(
  env: Record<string, string | undefined> = Bun.env,
  cwd: string = process.cwd(),
): string {
  return env.MISE_ORIGINAL_CWD ?? cwd;
}

const USAGE = "usage: mise run cleanup [-- --apply] [--no-fetch] [--idle-hours <n>]";

export async function main(argv: string[]): Promise<number> {
  let values: {
    apply?: boolean;
    "no-fetch"?: boolean;
    "idle-hours"?: string;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        apply: { type: "boolean" },
        "no-fetch": { type: "boolean" },
        "idle-hours": { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const idleHours = values["idle-hours"] === undefined ? undefined : Number(values["idle-hours"]);
  if (idleHours !== undefined && !(Number.isFinite(idleHours) && idleHours > 0)) {
    console.error(`--idle-hours must be a positive number\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(
      `${USAGE}\n  --apply     remove the worktrees and stop the processes the plan lists\n  --no-fetch  do not fetch origin main first\n  --idle-hours <n>  remove a worktree that never committed only after n idle hours (default ${DEFAULT_IDLE_HOURS}); every removal also waits ${MIN_QUIET_HOURS} h after its last activity`,
    );
    return 0;
  }

  const state = await gatherState({
    cwd: process.cwd(),
    currentDirectory: invokedDirectory(),
    fetch: !values["no-fetch"],
  });
  for (const warning of state.warnings) console.error(`warning: ${warning}`);
  const plan = planCleanup({ ...state, now: Date.now(), idleHours });
  console.log(formatPlan(plan));

  if (!values.apply) {
    if (plan.remove.length + plan.orphans.length > 0)
      console.log("\nDry run. Nothing was changed; run `mise run cleanup -- --apply` to do it.");
    return 0;
  }

  console.log("");
  const results = await applyPlan(plan);
  for (const result of results)
    console.log(
      `${result.ok ? "ok    " : "FAILED"} ${result.step}${result.detail ? `: ${result.detail}` : ""}`,
    );
  return results.some((result) => !result.ok) ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: Error) => {
    console.error(`cleanup failed: ${error.message}`);
    return 1;
  });
}
