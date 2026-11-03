import { afterEach, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyPlan, gatherState } from "./cleanup-system";
import type { GatherOptions } from "./cleanup-system";
import {
  branchNames,
  commitFile,
  failed,
  fixture,
  gitTest,
  HOUR,
  plan,
  reasons,
  removeTempDirs,
  run,
} from "./cleanup-test-repo";

afterEach(removeTempDirs);

const DAY = 24 * HOUR;
const idle = (days: number) => Date.now() + days * DAY;
const at = (ms: number) => new Date(ms);

/**
 * Plans as of `days` from now. Something in the repository must look recent, as it does in life
 * (a fetch, a sibling in use); the main checkout's index stands in, or the clock check would call
 * a repository where everything is old a wrong clock.
 */
async function stalePlan(
  main: string,
  days: number,
  options: Partial<Omit<GatherOptions, "cwd" | "fetch">> = {},
) {
  const now = idle(days);
  await utimes(join(main, ".git", "index"), at(now - 60_000), at(now - 60_000));
  return plan(main, { ...options, now });
}

describe("stale worktrees against a real repository", () => {
  gitTest(
    "removes a dirty and an unmerged worktree idle for 8 days, with their branches",
    async () => {
      const { main, wt } = await fixture();
      const result = await stalePlan(main, 8);

      const why = (name: string) =>
        result.remove.find((entry) => entry.worktree.path === wt(name))?.why;
      expect(why("dirty")).toBe("idle 8 days — removed with 1 uncommitted file (lost)");
      expect(why("unmerged")).toBe("idle 8 days — removed with 1 commit not on main (lost)");
      const results = await applyPlan(result, { rediscover: async () => [] });

      expect(failed(results)).toEqual([]);
      expect(existsSync(wt("dirty"))).toBe(false);
      expect(existsSync(wt("unmerged"))).toBe(false);
      expect(await branchNames(main)).toEqual(["main"]);
    },
  );

  gitTest("keeps the same worktrees at 6 days, with the usual reasons", async () => {
    const { main } = await fixture();
    const result = await plan(main, { now: idle(6) });
    expect(reasons(result).dirty).toBe("uncommitted changes");
    expect(reasons(result).unmerged).toContain("not on main");
  });

  gitTest("a process, a lock, the caller's directory still keep a stale worktree", async () => {
    const { main, wt } = await fixture();
    await run(main, "git", "worktree", "add", "-q", "-b", "mine", wt("mine"), "origin/main");
    await commitFile(wt("mine"), "mine.txt", "mine\n", "feat: mine");
    await run(main, "git", "worktree", "lock", wt("dirty"));

    const result = await stalePlan(main, 8, {
      currentDirectory: join(wt("mine"), "src"),
      processes: [{ pid: 9, command: "/bin/zsh -l", cwd: wt("unmerged"), cwdExists: true }],
    });

    expect(reasons(result).dirty).toBe("locked | uncommitted changes");
    expect(reasons(result).unmerged).toContain("process running (pid 9");
    expect(reasons(result).mine).toContain("the command runs inside it");
    const results = await applyPlan(result, { rediscover: async () => [] });
    expect(failed(results)).toEqual([]);
    for (const name of ["dirty", "unmerged", "mine"]) expect(existsSync(wt(name))).toBe(true);
  });

  gitTest("removes the worktree of main but keeps the branch", async () => {
    const { main, wt } = await fixture();
    await run(main, "git", "checkout", "-q", "-b", "parking");
    await run(main, "git", "worktree", "add", "-q", wt("mainwt"), "main");
    await writeFile(join(wt("mainwt"), "wip.txt"), "wip\n");

    const result = await stalePlan(main, 8);
    const results = await applyPlan(result, { rediscover: async () => [] });

    expect(failed(results)).toEqual([]);
    expect(existsSync(wt("mainwt"))).toBe(false);
    expect(await branchNames(main)).toContain("main");
    expect(results.find((step) => step.step === "keep branch main")?.detail).toBe(
      "protected branch",
    );
  });

  gitTest(
    "a file edited 30 minutes ago keeps a worktree whose last commit is 10 days old",
    async () => {
      const { main, wt } = await fixture();
      const now = idle(10);
      const edited = new Date(now - 30 * 60_000);
      await utimes(join(wt("dirty"), "scratch.txt"), edited, edited);

      const result = await plan(main, { now });

      // `dirty` was edited just now; `unmerged` has nothing but a 10-day-old commit.
      expect(reasons(result).dirty).toBe("uncommitted changes");
      expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("unmerged"));
      expect(result.remove.map((entry) => entry.worktree.path)).not.toContain(wt("dirty"));
    },
  );

  gitTest("a deleted tracked file counts by the directory it was deleted from", async () => {
    const { main, wt } = await fixture();
    await run(wt("unmerged"), "git", "rm", "-q", "unmerged.txt");
    const now = idle(10);
    const touched = new Date(now - 30 * 60_000);
    await utimes(wt("unmerged"), touched, touched);

    const result = await plan(main, { now });

    expect(reasons(result).unmerged).toContain("uncommitted changes");
  });

  gitTest("skips a stale removal when the worktree was used after the plan", async () => {
    const { main, wt } = await fixture();
    const result = await stalePlan(main, 8);
    const later = new Date(Date.now() + 60_000);
    await utimes(join(wt("dirty"), "scratch.txt"), later, later);
    await commitFile(wt("unmerged"), "late.txt", "late\n", "feat: late");

    const results = await applyPlan(result, { rediscover: async () => [] });

    expect(
      failed(results)
        .map((step) => step.step)
        .sort(),
    ).toEqual([`remove ${wt("dirty")}`, `remove ${wt("unmerged")}`]);
    for (const step of failed(results)) expect(step.detail).toContain("changed since the plan");
    expect(existsSync(wt("dirty"))).toBe(true);
    expect(existsSync(wt("unmerged"))).toBe(true);
    expect(await branchNames(main)).toEqual(expect.arrayContaining(["dirty", "unmerged"]));
  });

  describe("activity that git status does not show", () => {
    /** `unmerged` is otherwise 10 days idle; `prepare` makes one thing in it 30 minutes old. */
    async function keptBy(prepare: (dir: string, recent: Date, now: number) => Promise<void>) {
      const { main, wt } = await fixture();
      await appendFile(join(main, ".git", "info", "exclude"), ".env\n.cache/\n");
      const now = idle(10);
      await prepare(wt("unmerged"), at(now - 30 * 60_000), now);
      const result = await stalePlan(main, 10);
      expect(result.remove.map((entry) => entry.worktree.path)).not.toContain(wt("unmerged"));
      expect(reasons(result).unmerged).toContain("not on main");
    }

    gitTest("an edited ignored file", () =>
      keptBy(async (dir, recent) => {
        await writeFile(join(dir, ".env"), "SECRET=1\n");
        await utimes(join(dir, ".env"), recent, recent);
      }),
    );

    gitTest("a file in an ignored directory", () =>
      keptBy(async (dir, recent, now) => {
        await mkdir(join(dir, ".cache"));
        await writeFile(join(dir, ".cache", "data.txt"), "data\n");
        await utimes(join(dir, ".cache", "data.txt"), recent, recent);
        await utimes(join(dir, ".cache"), at(now - 20 * DAY), at(now - 20 * DAY));
      }),
    );

    gitTest("an edited skip-worktree file", () =>
      keptBy(async (dir, recent) => {
        await run(dir, "git", "update-index", "--skip-worktree", "base.txt");
        await writeFile(join(dir, "base.txt"), "edited\n");
        await utimes(join(dir, "base.txt"), recent, recent);
      }),
    );

    gitTest("an edited assume-unchanged file", () =>
      keptBy(async (dir, recent) => {
        await run(dir, "git", "update-index", "--assume-unchanged", "base.txt");
        await writeFile(join(dir, "base.txt"), "edited\n");
        await utimes(join(dir, "base.txt"), recent, recent);
      }),
    );

    gitTest("a file with an old mtime moved in, which only its directory shows", () =>
      keptBy(async (dir, recent, now) => {
        await writeFile(join(dir, "moved.txt"), "moved\n");
        await utimes(join(dir, "moved.txt"), at(now - 20 * DAY), at(now - 20 * DAY));
        await utimes(dir, recent, recent);
      }),
    );
  });

  gitTest("plans no stale removal when every worktree looks idle at once", async () => {
    const { main, wt } = await fixture();
    // No stand-in for a recent fetch or a busy sibling: the clock may be wrong.
    const result = await plan(main, { now: idle(12) });

    expect(result.clockNote).toContain("Check the system clock");
    expect(reasons(result).dirty).toContain("check the system clock");
    expect(reasons(result).unmerged).toContain("check the system clock");
    expect(result.remove.every((entry) => !entry.forced)).toBe(true);
    // Ordinary removals do not depend on the clock check.
    expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("merged"));
  });

  gitTest("a fetch counts as something recent", async () => {
    const { main } = await fixture();
    const gathered = await gatherState({ cwd: main, fetch: true, processes: [] });
    const fetchHead = Bun.file(join(main, ".git", "FETCH_HEAD"));
    expect(gathered.newestSeenMs).toBeGreaterThanOrEqual(fetchHead.lastModified);
  });

  describe("a last look for processes before work is thrown away", () => {
    gitTest("skips a stale worktree someone has entered since the plan", async () => {
      const { main, wt } = await fixture();
      const result = await stalePlan(main, 8);
      let looks = 0;

      const results = await applyPlan(result, {
        rediscover: async () => {
          looks++;
          return [{ pid: 7, command: "/bin/zsh -l", cwd: wt("dirty"), cwdExists: true }];
        },
      });

      expect(looks).toBe(1);
      expect(results.find((step) => step.step === `remove ${wt("dirty")}`)?.detail).toContain(
        "in use since the plan (pid 7",
      );
      expect(existsSync(wt("dirty"))).toBe(true);
      expect(existsSync(wt("unmerged"))).toBe(false);
    });

    gitTest(
      "skips every stale removal when the look fails, but not the ordinary ones",
      async () => {
        const { main, wt } = await fixture();
        const result = await stalePlan(main, 8);

        const results = await applyPlan(result, {
          rediscover: async () => {
            throw new Error("lsof failed");
          },
        });

        expect(
          failed(results)
            .map((step) => step.step)
            .sort(),
        ).toEqual([`remove ${wt("dirty")}`, `remove ${wt("unmerged")}`]);
        expect(failed(results)[0]!.detail).toContain("could not look for processes again");
        expect(existsSync(wt("dirty"))).toBe(true);
        expect(existsSync(wt("unmerged"))).toBe(true);
        expect(existsSync(wt("merged"))).toBe(false);
      },
    );

    gitTest("does not look when nothing is stale", async () => {
      const { main } = await fixture();
      const result = await plan(main);
      let looks = 0;
      await applyPlan(result, {
        rediscover: async () => {
          looks++;
          return [];
        },
      });
      expect(looks).toBe(0);
    });
  });
});
