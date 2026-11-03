import { describe, expect, test } from "bun:test";

import { main, summarize, type CleanupIo } from "./cleanup";
import type { Plan, WorktreeState } from "./cleanup-plan";
import type { StepResult } from "./cleanup-system";

const DAY = 24 * 3_600_000;

const worktree = (name: string, overrides: Partial<WorktreeState> = {}): WorktreeState => ({
  path: `/repo/.worktrees/${name}`,
  head: "h",
  branch: name,
  locked: false,
  prunable: false,
  changedFiles: 0,
  onMain: 1,
  notOnMain: 0,
  hasMerges: false,
  madeCommits: true,
  lastActivityMs: Date.now() - 2 * 3_600_000,
  reflogOnlyCommits: 0,
  ...overrides,
});

/** A console and a repository that cannot touch the real one: `apply` only records its plan. */
function fakeIo(worktrees: WorktreeState[], results: StepResult[] = []) {
  const log: string[] = [];
  const warnings: string[] = [];
  const applied: Plan[] = [];
  const io: CleanupIo = {
    gather: async () => ({
      mainPath: "/repo",
      worktrees,
      processes: [],
      currentDirectory: "/repo",
      warnings: ["slow network"],
      platform: "linux",
    }),
    apply: async (plan) => {
      applied.push(plan);
      return results;
    },
    cwd: "/repo",
    currentDirectory: "/repo",
    log: (line) => void log.push(line),
    warn: (line) => void warnings.push(line),
  };
  return { io, log, warnings, applied };
}

async function quietly<T>(body: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    return { value: await body(), errors };
  } finally {
    console.error = original;
  }
}

describe("mise run cleanup", () => {
  test("removes by default and summarises what it did", async () => {
    const { io, log, applied } = fakeIo(
      [worktree("done")],
      [
        { step: "remove /repo/.worktrees/done", ok: true },
        { step: "delete branch done", ok: true },
        { step: "terminate pid 4 (bun x.ts)", ok: true },
        { step: "remove /repo/.worktrees/busy", ok: true, detail: "kept, in use" },
      ],
    );

    expect(await main(["--no-fetch"], io)).toBe(0);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.remove.map((entry) => entry.worktree.branch)).toEqual(["done"]);
    expect(log.join("\n")).toContain(
      "Done: removed 1 worktree, deleted 1 branch, stopped 1 process; 0 failed.",
    );
    expect(log.join("\n")).not.toContain("Dry run");
  });

  test("--dry-run and -n only list, and say how to act", async () => {
    for (const flag of ["--dry-run", "-n"]) {
      const { io, log, applied } = fakeIo([worktree("done")]);
      expect(await main([flag], io)).toBe(0);
      expect(applied).toEqual([]);
      expect(log.join("\n")).toContain(
        "Dry run. Nothing was changed; run `mise run cleanup` to do it.",
      );
    }
  });

  test("does nothing, and says nothing about a dry run, when there is nothing to remove", async () => {
    const { io, log, applied } = fakeIo([]);
    expect(await main([], io)).toBe(0);
    expect(applied).toEqual([]);
    expect(log.join("\n")).toContain("Nothing to clean up");
  });

  test("exits 1 when a step failed, and shows the warnings", async () => {
    const { io, warnings } = fakeIo([worktree("done")], [{ step: "remove x", ok: false }]);
    expect(await main([], io)).toBe(1);
    expect(warnings).toEqual(["warning: slow network"]);
  });

  test("--apply is gone: it is an unknown option with the usage", async () => {
    const { io, applied } = fakeIo([worktree("done")]);
    const { value, errors } = await quietly(() => main(["--apply"], io));
    expect(value).toBe(2);
    expect(errors.join("\n")).toContain("usage: mise run cleanup [-- --dry-run|-n]");
    expect(applied).toEqual([]);
  });

  test("--idle-hours must be a positive number", async () => {
    for (const value of ["0", "-1", "abc", ""]) {
      const { io, applied } = fakeIo([worktree("done")]);
      const { value: code, errors } = await quietly(() => main([`--idle-hours=${value}`], io));
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--idle-hours must be a positive number");
      expect(applied).toEqual([]);
    }
  });

  test("--stale-days must be a number of days of at least the quiet period", async () => {
    for (const value of ["0", "-1", "abc", "", "0.04"]) {
      const { io, applied } = fakeIo([worktree("done")]);
      const { value: code, errors } = await quietly(() => main([`--stale-days=${value}`], io));
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--stale-days must be at least");
      expect(applied).toEqual([]);
    }
    const { io } = fakeIo([worktree("done")]);
    expect(await main(["--stale-days=0.05", "--dry-run"], io)).toBe(0);
  });

  test("the help lists every option", async () => {
    const { io, log } = fakeIo([]);
    expect(await main(["--help"], io)).toBe(0);
    for (const option of ["--dry-run, -n", "--no-fetch", "--idle-hours <n>", "--stale-days <n>"])
      expect(log.join("\n")).toContain(option);
  });

  test("--stale-days reaches the plan", async () => {
    const lossy = worktree("old", {
      changedFiles: 2,
      lastActivityMs: Date.now() - 4 * DAY,
    });
    const week = fakeIo([lossy]);
    await main([], week.io);
    expect(week.applied).toEqual([]);

    const short = fakeIo([lossy]);
    await main(["--stale-days", "3"], short.io);
    expect(short.applied[0]!.remove[0]!.forced).toBe(true);
    expect(short.log.join("\n")).toContain("removed with 2 uncommitted files (lost)");
  });

  test("summarize counts only steps that did something", () => {
    expect(
      summarize([
        { step: "remove a", ok: true },
        { step: "remove b", ok: true },
        { step: "keep branch a", ok: true, detail: "protected branch" },
        { step: "delete branch x", ok: false, detail: "boom" },
      ]),
    ).toBe("Done: removed 2 worktrees, deleted 0 branches, stopped 0 processes; 1 failed.");
  });
});
