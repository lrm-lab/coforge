import { afterEach, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { applyPlan } from "./cleanup-system";
import { failed, commitFile, fixture, gitTest, plan, removeTempDirs } from "./cleanup-test-repo";
import type { Signal, SignalHooks } from "./cleanup-windows";

afterEach(removeTempDirs);

const busy = (code: string) =>
  Object.assign(new Error(`${code}: resource busy or locked`), { code });

describe("Windows use check against a real repository", () => {
  gitTest("keeps a worktree Windows refuses to move, and removes one it moves", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, { platform: "win32", processes: undefined });
    expect(result.orphans).toEqual([]);
    expect(result.blocked).toBeUndefined();
    const moves: [string, string][] = [];

    const results = await applyPlan(result, {
      rename: async (from, to) => {
        moves.push([from, to]);
        if (from === wt("merged")) throw busy("EBUSY");
      },
    });

    expect(failed(results)).toEqual([]);
    const step = results.find((candidate) => candidate.step === `remove ${wt("merged")}`)!;
    expect(step.detail).toBe("kept, in use (Windows refused to move it)");
    expect(existsSync(wt("merged"))).toBe(true);
    expect(existsSync(wt("rebased"))).toBe(false);
    expect(existsSync(wt("fresh"))).toBe(false);
    // A free worktree is moved aside and straight back before git removes it.
    const aside = `${wt("rebased")}.cleanup-probe-${process.pid}`;
    expect(moves).toContainEqual([wt("rebased"), aside]);
    expect(moves).toContainEqual([aside, wt("rebased")]);
  });

  gitTest("EPERM and EACCES also mean in use", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, { platform: "win32" });
    const results = await applyPlan(result, {
      rename: async (from) => {
        if (from === wt("merged")) throw busy("EPERM");
        if (from === wt("rebased")) throw busy("EACCES");
      },
    });
    expect(failed(results)).toEqual([]);
    expect(existsSync(wt("merged"))).toBe(true);
    expect(existsSync(wt("rebased"))).toBe(true);
  });

  gitTest("stops and says where the worktree is when it cannot be moved back", async () => {
    const { main } = await fixture();
    const result = await plan(main, { platform: "win32" });
    const order = result.remove.map((entry) => entry.worktree.path);
    let calls = 0;

    const results = await applyPlan(result, {
      rename: async () => {
        if (++calls === 2) throw busy("EBUSY");
      },
    });

    const stuck = failed(results);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.step).toBe(`remove ${order[0]}`);
    expect(stuck[0]!.detail).toContain(`${order[0]}.cleanup-probe-${process.pid}`);
    expect(stuck[0]!.detail).toContain(`${order[0]}`);
    expect(stuck[0]!.detail).toContain("move it back by hand");
    expect(results).toHaveLength(1);
    for (const path of order) expect(existsSync(path)).toBe(true);
  });

  gitTest("never probes a worktree whose HEAD or status changed since the plan", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, { platform: "win32" });
    await commitFile(wt("merged"), "late.txt", "late\n", "feat: late");
    await writeFile(`${wt("rebased")}/late.txt`, "late\n");
    const moved: string[] = [];

    const results = await applyPlan(result, { rename: async (from) => void moved.push(from) });

    expect(moved.some((from) => from.startsWith(wt("merged")))).toBe(false);
    expect(moved.some((from) => from.startsWith(wt("rebased")))).toBe(false);
    expect(failed(results).map((step) => step.step)).toEqual(
      expect.arrayContaining([`remove ${wt("merged")}`, `remove ${wt("rebased")}`]),
    );
  });

  gitTest("reports a probe that fails for another reason and keeps the worktree", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, { platform: "win32" });

    const results = await applyPlan(result, {
      rename: async (from) => {
        if (from === wt("merged"))
          throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });

    const step = failed(results).find((candidate) => candidate.step === `remove ${wt("merged")}`)!;
    expect(step.detail).toContain("could not check whether it is in use");
    expect(existsSync(wt("merged"))).toBe(true);
  });

  gitTest("moves the worktree back and exits when interrupted during the probe", async () => {
    const { main, wt } = await fixture();
    const result = await plan(main, { platform: "win32" });
    const moves: [string, string][] = [];
    const exits: number[] = [];
    const installed: string[] = [];
    let handler: ((signal: Signal) => Promise<void>) | undefined;
    let interrupted: Promise<void> | undefined;
    const signals: SignalHooks = {
      install: (handle) => {
        handler = handle;
        installed.push("on");
        return () => void installed.push("off");
      },
      exit: (code) => void exits.push(code),
    };

    const results = await applyPlan(result, {
      signals,
      rename: async (from, to) => {
        moves.push([from, to]);
        // The interrupt arrives while the first worktree is still being moved aside.
        if (moves.length === 1) {
          await Promise.resolve();
          interrupted = handler!("SIGINT");
        }
      },
    });
    await interrupted;

    const first = result.remove[0]!.worktree.path;
    const aside = `${first}.cleanup-probe-${process.pid}`;
    expect(moves.slice(0, 2)).toEqual([
      [first, aside],
      [aside, first],
    ]);
    expect(exits).toEqual([130]);
    expect(failed(results)).toEqual([]);
    // Each probe installs the handler and removes it again.
    expect(installed.filter((event) => event === "on")).toHaveLength(
      installed.filter((event) => event === "off").length,
    );
    expect(existsSync(wt("dirty"))).toBe(true);
  });
});
