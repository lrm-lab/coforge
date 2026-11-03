// Plan inputs shared by the planner tests: a worktree in a known state, a process, a fixed clock.
import {
  MIN_QUIET_HOURS,
  planCleanup,
  type PlanInput,
  type ProcessInfo,
  type WorktreeState,
} from "./cleanup-plan";

export const NOW = Date.UTC(2026, 10, 3, 12);
export const HOUR = 3_600_000;
export const planAt = (input: Omit<PlanInput, "now">) => planCleanup({ now: NOW, ...input });

export const state = (path: string, overrides: Partial<WorktreeState> = {}): WorktreeState => ({
  path,
  head: "h",
  branch: `b-${path.split("/").pop()}`,
  locked: false,
  prunable: false,
  changedFiles: 0,
  onMain: 1,
  notOnMain: 0,
  hasMerges: false,
  madeCommits: true,
  lastActivityMs: NOW - (MIN_QUIET_HOURS + 1) * HOUR,
  reflogOnlyCommits: 0,
  ...overrides,
});

export const processAt = (
  pid: number,
  cwd: string,
  cwdExists: boolean,
  command = "bun server.ts",
): ProcessInfo => ({ pid, command, cwd, cwdExists });

export const reasonsOf = (plan: ReturnType<typeof planAt>, name: string) =>
  plan.keep.find((entry) => entry.worktree.path.endsWith(`/${name}`))?.reasons.join(" | ");
