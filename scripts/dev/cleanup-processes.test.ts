import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { formatPlan } from "./cleanup-plan";
import { DISCOVERY_TIMEOUT_MILLISECONDS } from "./cleanup-discovery";
import { FETCH_TIMEOUT_MILLISECONDS, gatherState } from "./cleanup-system";

import { applyPlan } from "./cleanup-system";
import {
  failed,
  fixture,
  gitTest,
  plan,
  procTree,
  reasons,
  removeTempDirs,
  run,
} from "./cleanup-test-repo";

afterEach(removeTempDirs);

describe("processes against a real repository", () => {
  gitTest(
    "any process inside a worktree keeps it; only bun and node orphans are signalled",
    async () => {
      const { main, wt } = await fixture();
      const result = await plan(main, {
        processes: [
          { pid: 4241, command: "/bin/zsh -l", cwd: wt("merged"), cwdExists: true },
          {
            pid: 4343,
            command: "bun proxy.ts",
            cwd: join(main, ".worktrees", "x"),
            cwdExists: false,
          },
          {
            pid: 4444,
            command: "/bin/zsh -l",
            cwd: join(main, ".worktrees", "y"),
            cwdExists: false,
          },
        ],
      });

      expect(result.remove.map((entry) => entry.worktree.path).sort()).toEqual([
        wt("fresh"),
        wt("rebased"),
      ]);
      expect(reasons(result).merged).toContain("process running");
      expect(result.orphans.map((process) => process.pid)).toEqual([4343]);
    },
  );

  gitTest(
    "stops orphans before removing worktrees, and only while the command line matches",
    async () => {
      const { main, wt } = await fixture();
      const result = await plan(main, {
        processes: [
          { pid: 1, command: "bun proxy.ts", cwd: join(main, ".worktrees", "x"), cwdExists: false },
          { pid: 2, command: "node old.js", cwd: join(main, ".worktrees", "x"), cwdExists: false },
          { pid: 3, command: "bun gone.ts", cwd: join(main, ".worktrees", "x"), cwdExists: false },
        ],
      });
      const killed: [number, boolean][] = [];

      const results = await applyPlan(result, {
        kill: (pid) => killed.push([pid, existsSync(wt("merged"))]),
        isAlive: () => false,
        commandOf: (pid) =>
          pid === 1 ? "bun proxy.ts" : pid === 2 ? "python reused.py" : undefined,
      });

      expect(killed).toEqual([[1, true]]);
      const byStep = (prefix: string) => results.find((step) => step.step.startsWith(prefix))!;
      expect(byStep("terminate pid 1").ok).toBe(true);
      expect(byStep("terminate pid 2")).toMatchObject({ ok: false });
      expect(byStep("terminate pid 2").detail).toContain("python reused.py");
      expect(byStep("terminate pid 3")).toMatchObject({ ok: true, detail: "already gone" });
      expect(existsSync(wt("merged"))).toBe(false);
    },
  );

  gitTest("reports an orphan that survives SIGTERM and does not kill it", async () => {
    const { main } = await fixture();
    const result = await plan(main, {
      processes: [
        {
          pid: 1,
          command: "bun stubborn.ts",
          cwd: join(main, ".worktrees", "x"),
          cwdExists: false,
        },
      ],
    });
    const signals: number[] = [];
    const results = await applyPlan(result, {
      kill: (pid) => signals.push(pid),
      isAlive: () => true,
      commandOf: () => "bun stubborn.ts",
      waitMilliseconds: 50,
    });
    expect(signals).toEqual([1]);
    expect(failed(results).map((step) => step.detail)).toEqual([
      "still running after SIGTERM; not killed",
    ]);
  });

  gitTest("refuses --apply, and says why, when the platform cannot be scanned", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, { platform: "plan9", processes: undefined });

    expect(result.remove.length).toBeGreaterThan(0);
    expect(result.blocked).toContain("supports macOS, Linux and Windows only");
    expect(formatPlan(result)).toContain("--apply will not remove any worktree");
    const results = await applyPlan(result, {});

    expect(failed(results)).toHaveLength(1);
    expect(failed(results)[0]!.detail).toContain("refused");
    expect(existsSync(wt("merged"))).toBe(true);
    expect(existsSync(wt("rebased"))).toBe(true);
  });

  gitTest("refuses --apply when the scan fails", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, {
      platform: "darwin",
      processes: undefined,
      run: async (command) => ({
        ok: command[0] === "ps",
        stdout: "",
        stderr: "lsof: broken",
        timedOut: false,
      }),
    });

    expect(result.blocked).toContain("lsof failed: lsof: broken");
    expect(failed(await applyPlan(result, {}))).toHaveLength(1);
    expect(existsSync(wt("merged"))).toBe(true);
  });

  gitTest(
    "on Linux a process in /proc keeps a worktree and a deleted directory is an orphan",
    async () => {
      const { main, wt } = await fixture();
      const procRoot = await procTree([
        { pid: process.pid, cwd: "/elsewhere", args: ["bun", "cleanup.ts"] },
        { pid: 2001, cwd: wt("merged"), args: ["/bin/zsh", "-l"] },
        { pid: 2002, cwd: `${join(main, ".worktrees", "x")} (deleted)`, args: ["bun", "proxy.ts"] },
        { pid: 2003, cwd: `${join(main, ".worktrees", "y")} (deleted)`, args: ["/bin/zsh", "-l"] },
      ]);

      const result = await plan(main, { platform: "linux", procRoot, processes: undefined });

      expect(result.blocked).toBeUndefined();
      expect(reasons(result).merged).toContain("process running (pid 2001, /bin/zsh -l)");
      expect(result.orphans.map((process) => process.pid)).toEqual([2002]);
    },
  );

  gitTest("never removes the worktree the user ran the command from, even under mise", async () => {
    const { main, wt } = await fixture();
    // mise runs the task in its config root (here the main checkout); the user stood in `merged`.
    const result = await plan(main, { currentDirectory: join(wt("merged"), "apps") });
    expect(reasons(result).merged).toBe("the command runs inside it");
    expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("rebased"));
    const gathered = await gatherState({ cwd: wt("merged"), fetch: false, processes: [] });
    expect(gathered.currentDirectory).toBe(wt("merged"));
  });

  // A real process in a worktree whose path contains a space; lsof (macOS) and /proc (Linux) must
  // both find it. Other platforms have no scan, so the test is skipped there with a reason.
  const realProcessTest = (platform: string, label: string) =>
    (process.platform === platform ? test : test.skip)(
      `a real process keeps its worktree, even with a space in the path (${label} only)`,
      async () => {
        const { main } = await fixture();
        const spaced = join(main, ".worktrees", "with space");
        await run(main, "git", "worktree", "add", "-q", "-b", "spaced", spaced, "origin/main");
        await Bun.write(join(spaced, "spaced.txt"), "spaced\n");
        await run(spaced, "git", "add", "spaced.txt");
        await run(spaced, "git", "commit", "-q", "-m", "feat: spaced");
        await run(spaced, "git", "push", "-q", "origin", "HEAD:main");
        const sleeper = Bun.spawn(["sleep", "60"], { cwd: spaced, stdout: "ignore" });
        try {
          const result = await plan(main, { processes: undefined });
          expect(result.blocked).toBeUndefined();
          const kept = result.keep.find((entry) => entry.worktree.path === spaced);
          expect(kept?.reasons.join()).toContain(`process running (pid ${sleeper.pid}, sleep 60)`);
          expect(kept?.busy).toBe(true);
        } finally {
          sleeper.kill();
          await sleeper.exited;
        }
      },
      FETCH_TIMEOUT_MILLISECONDS + DISCOVERY_TIMEOUT_MILLISECONDS,
    );
  realProcessTest("darwin", "macOS");
  realProcessTest("linux", "Linux");
});
