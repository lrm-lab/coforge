import { describe, expect, test } from "bun:test";

import {
  DEFAULT_IDLE_HOURS,
  formatPlan,
  isDevCommand,
  isInside,
  MIN_QUIET_HOURS,
  normalizePath,
  parseCherry,
  parseLsofCwd,
  parseProcessTable,
  parseReflog,
  parseWorktreeList,
} from "./cleanup-plan";
import { HOUR, NOW, planAt, processAt, reasonsOf, state } from "./cleanup-test-state";

describe("parseWorktreeList", () => {
  test("reads branches, detached heads, locks and prunable entries; the first is the main checkout", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/feature",
      "HEAD bbb",
      "branch refs/heads/feat/x",
      "",
      "worktree /repo/.worktrees/detached",
      "HEAD ccc",
      "detached",
      "locked",
      "",
      "worktree /repo/.worktrees/gone",
      "HEAD ddd",
      "branch refs/heads/gone",
      "locked reason with spaces",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/repo", head: "aaa", branch: "main", locked: false, prunable: false },
      {
        path: "/repo/.worktrees/feature",
        head: "bbb",
        branch: "feat/x",
        locked: false,
        prunable: false,
      },
      {
        path: "/repo/.worktrees/detached",
        head: "ccc",
        branch: undefined,
        locked: true,
        prunable: false,
      },
      {
        path: "/repo/.worktrees/gone",
        head: "ddd",
        branch: "gone",
        locked: true,
        prunable: true,
      },
    ]);
  });
});

describe("parseCherry", () => {
  test("counts commits already on main and commits that are not", () => {
    expect(parseCherry("")).toEqual({ onMain: 0, notOnMain: 0 });
    expect(parseCherry("- a1\n- b2\n")).toEqual({ onMain: 2, notOnMain: 0 });
    expect(parseCherry("- a1\n+ b2\n+ c3\n")).toEqual({ onMain: 1, notOnMain: 2 });
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("parseReflog", () => {
  test("a commit, cherry-pick or rebase pick yields the commit it reached", () => {
    for (const subject of [
      "commit: feat: x",
      "commit (amend): feat: x",
      "commit (merge): merge",
      "cherry-pick: feat: x",
      "revert: feat: x",
      "am: feat: x",
      "rebase (pick): feat: x",
    ])
      expect(
        parseReflog(`HEAD@{1700000100}|${SHA_A}|${subject}\nHEAD@{1700000000}|${SHA_B}|\n`),
      ).toEqual({
        committed: [SHA_A],
        lastActivityMs: 1700000100_000,
      });
  });

  test("creating, resetting, checking out and fast-forwarding yield none; a commit is listed once", () => {
    const reflog = [
      `HEAD@{1700000300}|${SHA_A}|rebase (finish): returning to refs/heads/x`,
      `HEAD@{1700000300}|${SHA_A}|rebase (start): checkout origin/main`,
      `HEAD@{1700000200}|${SHA_B}|merge origin/main: Fast-forward`,
      `HEAD@{1700000100}|${SHA_C}|reset: moving to HEAD`,
      `HEAD@{1700000000}|${SHA_C}|`,
    ].join("\n");
    expect(parseReflog(reflog)).toEqual({ committed: [], lastActivityMs: 1700000300_000 });
    expect(
      parseReflog(`HEAD@{2}|${SHA_A}|commit: x\nHEAD@{1}|${SHA_A}|commit (amend): x`).committed,
    ).toEqual([SHA_A]);
  });

  test("an empty reflog has no activity time", () => {
    expect(parseReflog("")).toEqual({ committed: [], lastActivityMs: undefined });
  });
});

describe("process parsers", () => {
  test("parseProcessTable maps each pid to its command line", () => {
    const listing =
      "  101 /Users/me/.bun/bin/bun scripts/dev/proxy.ts --port 8790\n  102 ssh host\nnotaline";
    expect(parseProcessTable(listing)).toEqual(
      new Map([
        [101, "/Users/me/.bun/bin/bun scripts/dev/proxy.ts --port 8790"],
        [102, "ssh host"],
      ]),
    );
  });

  test("isDevCommand accepts bun and node only", () => {
    expect(isDevCommand("/Users/me/.bun/bin/bun scripts/x.ts")).toBe(true);
    expect(isDevCommand("node /x/server.js")).toBe(true);
    expect(isDevCommand("bun")).toBe(true);
    for (const command of ["bunx something", "/bin/zsh -l", "ssh host", "nodemon x"])
      expect(isDevCommand(command)).toBe(false);
  });

  test("parseLsofCwd maps each pid to its command name and working directory", () => {
    const output =
      "p101\ncbun\nfcwd\nn/repo/.worktrees/x\np102\nczsh\nfcwd\nn/Users/me/with space\n";
    expect(parseLsofCwd(output)).toEqual(
      new Map([
        [101, { name: "bun", cwd: "/repo/.worktrees/x" }],
        [102, { name: "zsh", cwd: "/Users/me/with space" }],
      ]),
    );
  });
});

describe("Windows paths", () => {
  test("git's forward slashes and Bun's backslashes name the same directory, case-insensitively", () => {
    expect(isInside("C:/repo/.worktrees/a", "C:\\Repo\\.worktrees\\a", "win32")).toBe(true);
    expect(isInside("C:\\Repo\\.worktrees\\a\\src\\x", "c:/repo/.worktrees/a", "win32")).toBe(true);
    expect(normalizePath("C:\\Repo\\x\\", "win32")).toBe("c:/repo/x");
  });

  test("a sibling that shares a prefix is outside, with either separator", () => {
    expect(isInside("C:/repository-other", "C:/repo", "win32")).toBe(false);
    expect(isInside("C:\\repository-other\\x", "C:/repo", "win32")).toBe(false);
    expect(isInside("D:/repo/x", "C:/repo", "win32")).toBe(false);
  });

  test("elsewhere a path is compared exactly", () => {
    expect(normalizePath("/Repo/x", "linux")).toBe("/Repo/x");
    expect(isInside("/repo/a", "/Repo", "linux")).toBe(false);
    expect(isInside("/repo/a/b", "/repo/a", "darwin")).toBe(true);
    expect(isInside("/repo/a-b", "/repo/a", "darwin")).toBe(false);
  });
});

describe("planCleanup", () => {
  const main = "/repo";

  test("removes a clean, quiet worktree whose commits are all on main", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [state("/repo/.worktrees/done")],
      processes: [],
    });
    expect(plan.remove.map((entry) => entry.worktree.path)).toEqual(["/repo/.worktrees/done"]);
    expect(plan.remove[0]!.why).toContain("1 commit");
    expect(plan.keep).toEqual([]);
  });

  test("a worktree whose commit was fast-forwarded into main waits for the quiet period", () => {
    const quiet = state("/repo/.worktrees/ff", { onMain: 0 });
    const fresh = state("/repo/.worktrees/ff-fresh", {
      onMain: 0,
      lastActivityMs: NOW - (MIN_QUIET_HOURS * HOUR) / 2,
    });
    const plan = planAt({ mainPath: main, worktrees: [quiet, fresh], processes: [] });
    expect(plan.remove.map((entry) => entry.worktree.path)).toEqual(["/repo/.worktrees/ff"]);
    expect(plan.remove[0]!.why).toContain("on origin/main");
    expect(reasonsOf(plan, "ff-fresh")).toContain("recently active");
  });

  test("a worktree that never committed waits for the idle limit, however quiet", () => {
    const fresh = state("/repo/.worktrees/new", {
      onMain: 0,
      madeCommits: false,
      lastActivityMs: NOW - (DEFAULT_IDLE_HOURS - 1) * HOUR,
    });
    const old = state("/repo/.worktrees/old", {
      onMain: 0,
      madeCommits: false,
      lastActivityMs: NOW - 2 * 24 * HOUR,
    });
    const plan = planAt({ mainPath: main, worktrees: [fresh, old], processes: [] });
    expect(reasonsOf(plan, "new")).toContain("new worktree, no commits yet");
    expect(plan.remove.map((entry) => entry.worktree.path)).toEqual(["/repo/.worktrees/old"]);
    expect(plan.remove[0]!.why).toContain("no commits, idle for 2 days");
  });

  test("--idle-hours moves the limit, and an unknown activity time keeps the worktree", () => {
    const quiet = state("/repo/.worktrees/q", {
      onMain: 0,
      madeCommits: false,
      lastActivityMs: NOW - 3 * HOUR,
    });
    const unknown = state("/repo/.worktrees/u", { lastActivityMs: undefined });
    const plan = planAt({
      mainPath: main,
      worktrees: [quiet, unknown],
      processes: [],
      idleHours: 2,
    });
    expect(plan.remove.map((entry) => entry.worktree.path)).toEqual(["/repo/.worktrees/q"]);
    expect(reasonsOf(plan, "u")).toBe("last activity unknown");
  });

  test("keeps worktrees that are dirty, not on main, merged, locked, unreadable or in use", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [
        state("/repo/.worktrees/dirty", { changedFiles: 2 }),
        state("/repo/.worktrees/unmerged", { notOnMain: 2 }),
        state("/repo/.worktrees/locked", { locked: true }),
        state("/repo/.worktrees/busy"),
        state("/repo/.worktrees/merges", { hasMerges: true }),
        state("/repo/.worktrees/lost", { branch: undefined, reflogOnlyCommits: 2 }),
        state("/repo/.worktrees/broken", { error: "git status failed: boom" }),
        state("/repo/.worktrees/here"),
        state("/repo/.worktrees/many", { changedFiles: 2, notOnMain: 1 }),
      ],
      processes: [
        processAt(7, "/repo/.worktrees/busy/apps/web", true, "/bin/zsh -l"),
        processAt(8, "/repo/.worktrees/gone-dir", false),
      ],
      currentDirectory: "/repo/.worktrees/here/packages",
    });
    expect(plan.remove).toEqual([]);
    expect(reasonsOf(plan, "dirty")).toBe("uncommitted changes");
    expect(reasonsOf(plan, "unmerged")).toContain("not on main");
    expect(reasonsOf(plan, "unmerged")).toContain("2 commits");
    expect(reasonsOf(plan, "locked")).toBe("locked");
    expect(reasonsOf(plan, "busy")).toContain("process running (pid 7, /bin/zsh -l)");
    expect(reasonsOf(plan, "merges")).toBe("has merge commits not on main");
    expect(reasonsOf(plan, "lost")).toContain("commits only in its reflog");
    expect(reasonsOf(plan, "broken")).toContain("could not inspect it (git status failed: boom)");
    expect(reasonsOf(plan, "here")).toBe("the command runs inside it");
    expect(reasonsOf(plan, "many")).toContain("uncommitted changes | not on main");
    expect(plan.keep.filter((entry) => entry.busy).map((entry) => entry.worktree.path)).toEqual([
      "/repo/.worktrees/busy",
    ]);
  });

  test("a prunable worktree needs no activity time; a detached one is kept", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [
        state("/repo/.worktrees/gone", { prunable: true, lastActivityMs: undefined, onMain: 0 }),
        state("/repo/.worktrees/gone-detached", {
          prunable: true,
          branch: undefined,
          lastActivityMs: undefined,
        }),
      ],
      processes: [],
    });
    expect(plan.remove.map((entry) => entry.worktree.path)).toEqual(["/repo/.worktrees/gone"]);
    expect(plan.remove[0]!.why).toContain("directory is already gone");
    expect(reasonsOf(plan, "gone-detached")).toContain("HEAD is detached");
  });

  test("a sibling path that only shares a prefix is not inside the worktree", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [state("/repo/.worktrees/a")],
      processes: [processAt(7, "/repo/.worktrees/a-b", true)],
      currentDirectory: "/repo/.worktrees/a-c",
    });
    expect(plan.remove).toHaveLength(1);
  });

  test("orphans are bun or node processes whose directory is gone and was inside the repository", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [state("/elsewhere/wt")],
      processes: [
        processAt(1, "/repo/.worktrees/removed", false),
        processAt(2, "/repo", false, "/Users/me/.bun/bin/bun x.ts"),
        processAt(3, "/repo/.worktrees/alive", true),
        processAt(4, "/unrelated/gone", false),
        processAt(5, "/elsewhere/wt/deleted-subdir", false, "node y.js"),
        processAt(6, "/repository-other/gone", false),
        processAt(9, "/repo/.worktrees/removed", false, "/bin/zsh -l"),
      ],
    });
    expect(plan.orphans.map((process) => process.pid)).toEqual([1, 2, 5]);
  });

  test("formats the plan in groups, warns about ignored files, and explains live processes", () => {
    const plan = planAt({
      mainPath: main,
      worktrees: [
        state("/repo/.worktrees/done", { branch: "feat/done", onMain: 3 }),
        state("/repo/.worktrees/busy"),
        state("/repo/.worktrees/unmerged", { notOnMain: 1 }),
      ],
      processes: [
        processAt(7, "/repo/.worktrees/busy", true),
        processAt(9, "/repo/.worktrees/old", false),
      ],
    });
    const text = formatPlan(plan);
    expect(text).toContain("Worktrees to remove (1)");
    expect(text).toContain("/repo/.worktrees/done");
    expect(text).toContain("feat/done");
    expect(text).toContain("ignored files (.env, copied infra/secrets, local data)");
    expect(text).toContain("Worktrees kept (2)");
    expect(text).toContain("squash");
    expect(text).toContain("Orphan processes (1)");
    expect(text).toContain("pid 9");
    expect(text).toContain("/repo/.worktrees/old");
    expect(text).toContain("A live process inside a worktree keeps that worktree");
  });

  test("on Windows the command's directory is matched by normalised path, and probing is announced", () => {
    const plan = planAt({
      mainPath: "C:/repo",
      worktrees: [state("C:/repo/.worktrees/a"), state("C:/repo/.worktrees/b")],
      processes: [],
      currentDirectory: "C:\\Repo\\.worktrees\\A\\src",
      platform: "win32",
    });
    expect(plan.keep.map((entry) => entry.worktree.path)).toEqual(["C:/repo/.worktrees/a"]);
    expect(plan.keep[0]!.reasons).toEqual(["the command runs inside it"]);
    const text = formatPlan(plan);
    expect(text).toContain("will be checked for use before removal");
    expect(text).toContain("Orphan processes: not applicable on Windows");
    expect(
      formatPlan(
        planAt({ mainPath: main, worktrees: [state("/repo/.worktrees/a")], processes: [] }),
      ),
    ).not.toContain("checked for use");
  });

  test("formats an empty plan", () => {
    const text = formatPlan(planAt({ mainPath: main, worktrees: [], processes: [] }));
    expect(text).toContain("Nothing to clean up");
  });
});
