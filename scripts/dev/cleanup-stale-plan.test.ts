import { describe, expect, test } from "bun:test";

import {
  MIN_QUIET_HOURS,
  parseHiddenFiles,
  parseStatus,
  STALE_DAYS,
  type WorktreeState,
  formatPlan,
} from "./cleanup-plan";
import { HOUR, NOW, planAt, processAt, reasonsOf, state } from "./cleanup-test-state";

const main = "/repo";

describe("stale worktrees", () => {
  const DAY = 24 * HOUR;
  const idleFor = (days: number, overrides: Partial<WorktreeState> = {}) =>
    state("/repo/.worktrees/old", { lastActivityMs: NOW - days * DAY, ...overrides });
  const lossy = { changedFiles: 3, notOnMain: 2 };

  test(`removes what is idle for ${STALE_DAYS} days whatever it holds, and says what is lost`, () => {
    const plan = planAt({ mainPath: main, worktrees: [idleFor(12, lossy)], processes: [] });
    expect(plan.keep).toEqual([]);
    expect(plan.remove[0]!.forced).toBe(true);
    expect(plan.remove[0]!.why).toBe(
      "idle 12 days \u2014 removed with 3 uncommitted files and 2 commits not on main (lost)",
    );
  });

  test("lists every kind of loss", () => {
    const worktree = idleFor(9, {
      changedFiles: 1,
      notOnMain: 1,
      hasMerges: true,
      branch: undefined,
      reflogOnlyCommits: 4,
    });
    const plan = planAt({ mainPath: main, worktrees: [worktree], processes: [] });
    expect(plan.remove[0]!.why).toBe(
      "idle 9 days \u2014 removed with 1 uncommitted file, 1 commit not on main, merge commits not on main and 4 commits only in its reflog (lost)",
    );
  });

  test("keeps what is idle for less, with the usual reasons", () => {
    const plan = planAt({ mainPath: main, worktrees: [idleFor(6, lossy)], processes: [] });
    expect(plan.remove).toEqual([]);
    expect(reasonsOf(plan, "old")).toContain("uncommitted changes | not on main");
  });

  test("--stale-days moves the limit", () => {
    const worktrees = [idleFor(4, lossy)];
    expect(planAt({ mainPath: main, worktrees, processes: [] }).remove).toEqual([]);
    const plan = planAt({ mainPath: main, worktrees, processes: [], staleDays: 3 });
    expect(plan.remove[0]!.forced).toBe(true);
  });

  test("a stale worktree that holds nothing is removed the ordinary way", () => {
    const plan = planAt({ mainPath: main, worktrees: [idleFor(30)], processes: [] });
    expect(plan.remove[0]!.forced).toBe(false);
    expect(plan.remove[0]!.why).toContain("on origin/main");
  });

  test("a process, a lock, the caller's directory or an unreadable worktree still keep it", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [
        idleFor(30, { ...lossy, path: "/repo/.worktrees/busy" }),
        idleFor(30, { ...lossy, path: "/repo/.worktrees/locked", locked: true }),
        idleFor(30, { ...lossy, path: "/repo/.worktrees/here" }),
        idleFor(30, { ...lossy, path: "/repo/.worktrees/broken", error: "git failed" }),
      ],
      processes: [processAt(7, "/repo/.worktrees/busy", true, "/bin/zsh -l")],
      currentDirectory: "/repo/.worktrees/here/src",
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keep.map((entry) => entry.worktree.path.split("/").pop())).toEqual([
      "busy",
      "locked",
      "here",
      "broken",
    ]);
  });

  test("an unknown activity time is never stale", () => {
    const worktree = idleFor(30, { ...lossy, lastActivityMs: undefined });
    expect(planAt({ mainPath: main, worktrees: [worktree], processes: [] }).remove).toEqual([]);
  });

  test("the limit is never shorter than the quiet period", () => {
    const worktree = idleFor(0, { ...lossy, lastActivityMs: NOW - (MIN_QUIET_HOURS * HOUR) / 2 });
    const plan = planAt({ mainPath: main, worktrees: [worktree], processes: [], staleDays: 0.001 });
    expect(plan.remove).toEqual([]);
  });

  describe("a clock that jumped forward", () => {
    const DAYS = 24 * HOUR;
    const worktrees = [idleFor(12, lossy), idleFor(12, { path: "/repo/.worktrees/clean" })];

    test("plans no stale removal when nothing in the repository is recent, and says why", () => {
      const plan = planAt({
        mainPath: main,
        worktrees,
        processes: [],
        newestSeenMs: NOW - 12 * DAYS,
      });
      expect(plan.remove.map((entry) => entry.forced)).toEqual([false]);
      expect(reasonsOf(plan, "old")).toContain("every worktree looks idle; check the system clock");
      expect(plan.clockNote).toContain("Check the system clock");
      expect(formatPlan(plan)).toContain("Check the system clock");
    });

    test("something recent anywhere (a fetch, a busy sibling) is enough to trust the clock", () => {
      const plan = planAt({
        mainPath: main,
        worktrees,
        processes: [],
        newestSeenMs: NOW - HOUR,
      });
      expect(plan.remove.map((entry) => entry.forced)).toEqual([true, false]);
      expect(plan.clockNote).toBeUndefined();
    });

    test("a short stale limit is not mistaken for a clock jump within a day", () => {
      const plan = planAt({
        mainPath: main,
        worktrees: [idleFor(0.5, lossy)],
        processes: [],
        newestSeenMs: NOW - 12 * HOUR,
        staleDays: 0.25,
      });
      expect(plan.remove[0]!.forced).toBe(true);
    });
  });
});

describe("what status and ls-files report", () => {
  test("parseStatus lists each entry once and marks the ignored ones", () => {
    const output = "?? a.txt\0 M b/c d.txt\0R  new.txt\0old.txt\0!! .env\0!! node_modules/\0";
    expect(parseStatus(output)).toEqual([
      { path: "a.txt", ignored: false },
      { path: "b/c d.txt", ignored: false },
      { path: "new.txt", ignored: false },
      { path: ".env", ignored: true },
      { path: "node_modules/", ignored: true },
    ]);
    expect(parseStatus("")).toEqual([]);
  });

  test("parseHiddenFiles keeps skip-worktree and assume-unchanged files only", () => {
    const output = "H kept.txt\0S skipped.txt\0h assumed/a b.txt\0M merge.txt\0s both.txt\0";
    expect(parseHiddenFiles(output)).toEqual(["skipped.txt", "assumed/a b.txt", "both.txt"]);
  });
});
