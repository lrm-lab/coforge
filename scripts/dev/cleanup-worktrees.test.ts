import { afterEach, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseWorktreeList, planCleanup } from "./cleanup-plan";
import { type Runner } from "./cleanup-exec";
import { applyPlan, FETCH_TIMEOUT_MILLISECONDS, gatherState } from "./cleanup-system";
import {
  branchNames,
  commitFile,
  failed,
  fixture,
  gitTest,
  later,
  plan,
  reasons,
  removeTempDirs,
  run,
} from "./cleanup-test-repo";

afterEach(removeTempDirs);

describe("against a real repository", () => {
  gitTest("plans and removes only the worktrees whose change is on main", async () => {
    const { main, wt } = await fixture();

    const gathered = await gatherState({ cwd: wt("unmerged"), fetch: true, processes: [] });
    expect(gathered.mainPath).toBe(main);
    const result = planCleanup({ ...gathered, now: later() });

    expect(result.remove.map((entry) => entry.worktree.path).sort()).toEqual([
      wt("fresh"),
      wt("merged"),
      wt("rebased"),
    ]);
    expect(reasons(result).unmerged).toContain("not on main");
    expect(reasons(result).dirty).toBe("uncommitted changes");

    const results = await applyPlan(result, {});
    expect(failed(results)).toEqual([]);

    const remaining = parseWorktreeList(await run(main, "git", "worktree", "list", "--porcelain"));
    expect(remaining.map((entry) => entry.path).sort()).toEqual(
      [main, wt("dirty"), wt("unmerged")].sort(),
    );
    // `rebased` had commits of its own that are all on main; `merged` and `fresh` have tips already
    // in origin/main and hold nothing beyond it. All three are deleted; the rest stay.
    expect(await branchNames(main)).toEqual(["dirty", "main", "unmerged"]);
    for (const branch of ["rebased", "merged", "fresh"])
      expect(results.find((step) => step.step === `delete branch ${branch}`)?.ok).toBe(true);
  });

  gitTest("nothing that was active within the quiet period is removed", async () => {
    const { main } = await fixture();
    const result = await plan(main, { now: Date.now() });
    expect(result.remove).toEqual([]);
    expect(reasons(result).merged).toContain("recently active");
    expect(reasons(result).rebased).toContain("recently active");
    expect(reasons(result).fresh).toContain("new worktree, no commits yet");
  });

  gitTest("planning twice reads the same activity times, so reading is not activity", async () => {
    const { main } = await fixture();
    const times = async () =>
      (await gatherState({ cwd: main, fetch: false, processes: [] })).worktrees.map(
        (worktree) => worktree.lastActivityMs,
      );
    expect(await times()).toEqual(await times());
  });

  gitTest("never deletes main when a linked worktree has it checked out", async () => {
    const { main, wt } = await fixture();
    // Local main has a commit of its own whose patch is on origin/main under another hash, so only
    // the branch's name keeps it from looking deletable.
    await commitFile(main, "own.txt", "own\n", "feat: own");
    await run(main, "git", "worktree", "add", "-q", "--detach", wt("pusher"), "origin/main");
    await run(wt("pusher"), "git", "cherry-pick", "main");
    await run(wt("pusher"), "git", "push", "-q", "origin", "HEAD:main");
    await run(main, "git", "worktree", "remove", wt("pusher"));
    await run(main, "git", "checkout", "-q", "-b", "parking");
    await run(main, "git", "worktree", "add", "-q", wt("mainwt"), "main");

    const result = await plan(main);
    expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("mainwt"));
    const results = await applyPlan(result, {});

    expect(failed(results)).toEqual([]);
    expect(await branchNames(main)).toContain("main");
    expect(results.find((step) => step.step === "keep branch main")?.detail).toBe(
      "protected branch",
    );
  });

  gitTest("keeps a detached worktree whose commits only its reflog holds", async () => {
    const { main, wt } = await fixture();
    await run(main, "git", "worktree", "add", "-q", "--detach", wt("lost"), "origin/main");
    await commitFile(wt("lost"), "lost.txt", "lost\n", "feat: lost");
    await run(wt("lost"), "git", "checkout", "-q", "--detach", "origin/main");
    // The same shape, but the commit was pushed to main before HEAD moved off it.
    await run(main, "git", "worktree", "add", "-q", "--detach", wt("pushed"), "origin/main");
    await commitFile(wt("pushed"), "pushed.txt", "pushed\n", "feat: pushed");
    await run(wt("pushed"), "git", "push", "-q", "origin", "HEAD:main");
    await run(wt("pushed"), "git", "checkout", "-q", "--detach", "origin/main");

    const result = await plan(main);

    expect(reasons(result)[wt("lost")]).toContain("commits only in its reflog");
    expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("pushed"));
  });

  gitTest("keeps a worktree with merge commits that are not on main", async () => {
    const { main, wt } = await fixture();
    await run(main, "git", "branch", "side", "main");
    await run(main, "git", "worktree", "add", "-q", "-b", "merging", wt("merging"), "main");
    await run(main, "git", "worktree", "add", "-q", "-b", "sideline", wt("sideline"), "side");
    await commitFile(wt("sideline"), "side.txt", "side\n", "feat: side");
    await commitFile(wt("merging"), "own.txt", "own\n", "feat: own");
    await run(wt("merging"), "git", "merge", "-q", "--no-ff", "-m", "merge side", "sideline");

    const gathered = await gatherState({ cwd: main, fetch: false, processes: [] });

    expect(gathered.worktrees.find((entry) => entry.path === wt("merging"))?.hasMerges).toBe(true);
    expect(reasons(planCleanup({ ...gathered, now: later() })).merging).toContain(
      "has merge commits not on main",
    );
  });

  gitTest("keeps the worktree the command runs in", async () => {
    const { wt } = await fixture();
    const result = await plan(wt("merged"));
    expect(reasons(result).merged).toBe("the command runs inside it");
  });

  gitTest(
    "a worktree changed after planning is left alone: a new commit, or a new file",
    async () => {
      const { main, wt } = await fixture();
      const result = await plan(main);
      await commitFile(wt("merged"), "late.txt", "late\n", "feat: late");
      await writeFile(join(wt("rebased"), "late.txt"), "late\n");

      const results = await applyPlan(result, {});

      expect(
        failed(results)
          .map((step) => step.step)
          .sort(),
      ).toEqual([`remove ${wt("merged")}`, `remove ${wt("rebased")}`]);
      expect(results.find((step) => step.step === `remove ${wt("merged")}`)?.detail).toContain(
        "changed since the plan",
      );
      expect(existsSync(join(wt("merged"), "late.txt"))).toBe(true);
      expect(existsSync(join(wt("rebased"), "late.txt"))).toBe(true);
      expect(await branchNames(main)).toEqual(expect.arrayContaining(["merged", "rebased"]));
    },
  );

  gitTest("keeps a branch that gained commits not on main after planning", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main);
    // The worktree is removed, but the branch it held is another one that has unmerged work.
    await run(main, "git", "branch", "spare", "unmerged");
    const entry = result.remove.find((candidate) => candidate.worktree.path === wt("rebased"))!;
    entry.worktree = { ...entry.worktree, branch: "spare" };

    const results = await applyPlan(result, {});

    expect(await branchNames(main)).toContain("spare");
    expect(results.find((step) => step.step === "keep branch spare")?.detail).toContain(
      "without an equivalent",
    );
  });

  gitTest("keeps a branch that another worktree still has checked out", async () => {
    const { main, wt } = await fixture();
    await run(main, "git", "worktree", "add", "-q", "-f", wt("twin"), "rebased");
    await writeFile(join(wt("twin"), "scratch.txt"), "scratch\n");

    const result = await plan(main);
    expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("rebased"));
    expect(reasons(result).rebased).toBe("uncommitted changes");
    const results = await applyPlan(result, {});

    expect(await branchNames(main)).toContain("rebased");
    expect(results.find((step) => step.step === "keep branch rebased")?.detail).toBe(
      "checked out elsewhere",
    );
  });

  gitTest(
    "keeps a locked worktree, removes the record of a missing one, and leaves other missing ones",
    async () => {
      const { main, wt } = await fixture();
      const mergedAndPushed = async (name: string, ...options: string[]) => {
        await run(main, "git", "worktree", "add", "-q", ...options, wt(name), "origin/main");
        if (options.includes("--detach")) return;
        await commitFile(wt(name), `${name}.txt`, `${name}\n`, `feat: ${name}`);
        await run(wt(name), "git", "push", "-q", "origin", "HEAD:main");
      };
      await mergedAndPushed("locked", "-b", "locked");
      await run(main, "git", "worktree", "lock", wt("locked"));
      await mergedAndPushed("gone", "-b", "gone");
      await rm(wt("gone"), { recursive: true });
      await mergedAndPushed("gone-detached", "--detach");
      await rm(wt("gone-detached"), { recursive: true });

      const result = await plan(main);

      expect(reasons(result).locked).toBe("locked");
      expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("gone"));
      expect(reasons(result)[wt("gone-detached")]).toContain("HEAD is detached");

      expect(failed(await applyPlan(result, {}))).toEqual([]);
      const listed = await run(main, "git", "worktree", "list", "--porcelain");
      expect(listed).toContain(wt("locked"));
      expect(listed).toContain(wt("gone-detached"));
      expect(listed).not.toContain(`worktree ${wt("gone")}\n`);
    },
  );

  gitTest(
    "a worktree git cannot read is kept with the error, and the others are still planned",
    async () => {
      const { main, wt } = await fixture();
      await run(main, "git", "worktree", "add", "-q", "-b", "broken", wt("broken"), "origin/main");
      await writeFile(join(wt("broken"), ".git"), "garbage\n");

      const result = await plan(main);

      expect(reasons(result).broken).toContain("could not inspect it");
      expect(result.remove.map((entry) => entry.worktree.path)).toContain(wt("merged"));
    },
  );

  /** Plans, then makes the plan name `branch` for the worktree `rebased`, whose own branch stays. */
  async function planDeleting(main: string, wt: (name: string) => string, branches: string[]) {
    const result = await plan(main);
    const names = ["rebased", "merged"];
    branches.forEach((branch, index) => {
      const entry = result.remove.find((c) => c.worktree.path === wt(names[index]!))!;
      entry.worktree = { ...entry.worktree, branch };
    });
    return result;
  }

  gitTest("keeps a branch whose commits are on main but whose history has a merge", async () => {
    const { main, wt } = await fixture();
    await run(main, "git", "worktree", "add", "-q", "-b", "mergy", wt("mergy"), "origin/main");
    await run(main, "git", "worktree", "add", "-q", "-b", "side", wt("side"), "origin/main");
    await commitFile(wt("mergy"), "x.txt", "x\n", "feat: x");
    await commitFile(wt("side"), "y.txt", "y\n", "feat: y");
    await run(wt("mergy"), "git", "merge", "-q", "--no-ff", "-m", "merge y", "side");
    // Main gets both commits as new commits, so every non-merge commit has an equivalent there.
    await run(main, "git", "worktree", "add", "-q", "--detach", wt("pusher"), "origin/main");
    await run(wt("pusher"), "git", "cherry-pick", "mergy^1", "side");
    await run(wt("pusher"), "git", "push", "-q", "origin", "HEAD:main");
    for (const name of ["pusher", "mergy", "side"])
      await run(main, "git", "worktree", "remove", "--force", wt(name));
    expect(await run(main, "git", "cherry", "origin/main", "mergy")).not.toContain("+ ");

    const result = await planDeleting(main, wt, ["mergy"]);
    const results = await applyPlan(result, {});

    expect(await branchNames(main)).toContain("mergy");
    expect(results.find((step) => step.step === "keep branch mergy")).toBeDefined();
  });

  gitTest("never deletes master or the branch origin/HEAD points to", async () => {
    const { main, wt } = await fixture();
    // Both sit at the base commit, so only their names keep them from looking deletable.
    await run(main, "git", "branch", "master", "main");
    await run(main, "git", "branch", "trunk", "main");
    await run(main, "git", "update-ref", "refs/remotes/origin/trunk", "origin/main");
    await run(main, "git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

    const result = await planDeleting(main, wt, ["trunk", "master"]);
    const results = await applyPlan(result, {});

    expect(await branchNames(main)).toEqual(expect.arrayContaining(["master", "trunk"]));
    for (const branch of ["master", "trunk"])
      expect(results.find((step) => step.step === `keep branch ${branch}`)?.detail).toBe(
        "protected branch",
      );
  });

  gitTest("fetches origin main without a credential prompt and under a timeout", async () => {
    const { main } = await fixture();
    const calls: { command: string[]; env?: Record<string, string>; timeout?: number }[] = [];
    const run: Runner = async (command, options) => {
      calls.push({ command, env: options?.env, timeout: options?.timeout });
      return { ok: false, stdout: "", stderr: "", timedOut: true };
    };

    const gathered = await gatherState({ cwd: main, fetch: true, processes: [], run });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toEqual(["git", "fetch", "--quiet", "origin", "main"]);
    expect(calls[0]!.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls[0]!.timeout).toBe(FETCH_TIMEOUT_MILLISECONDS);
    expect(FETCH_TIMEOUT_MILLISECONDS).toBe(30_000);
    expect(gathered.warnings.join()).toContain("timed out after 30 s");
  });

  gitTest("keeps a branch that moved after it was checked", async () => {
    const { main, wt } = await fixture();
    const result = await planDeleting(main, wt, ["drifter"]);
    await run(main, "git", "branch", "drifter", "main");

    const results = await applyPlan(result, {
      beforeBranchDelete: async (branch) => {
        if (branch !== "drifter") return;
        // Someone commits to the branch between the check and the deletion.
        await run(main, "git", "update-ref", "refs/heads/drifter", "unmerged");
      },
    });

    expect(await branchNames(main)).toContain("drifter");
    expect(results.find((step) => step.step === "keep branch drifter")?.detail).toBe(
      "moved while it was checked",
    );
  });
});
