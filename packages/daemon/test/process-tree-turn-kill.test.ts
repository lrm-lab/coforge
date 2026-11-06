import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { OwnedProcessIdentity, OwnedProcessTree } from "@lrm/coforge-anvil";
import { ProcessTreeOwner } from "#src/platform/process-tree";

const env = { PATH: globalThis.process.env.PATH ?? "" };

type TableEntry = { pid: number; ppid: number; startedAtMs: number; pgid?: number };

/** A spawned "agent" plus scripted table rows; the rows' pids are real sleeps the kill reaches. */
async function fixture(
  entries: (mainPid: number) => TableEntry[],
  mainPpid: number = globalThis.process.pid,
) {
  const spawned: { kill(signal?: "SIGKILL"): void; exited: Promise<unknown> }[] = [];
  const tree: OwnedProcessTree = new ProcessTreeOwner(undefined, undefined, {
    processTable: {
      resolutionMs: 1_000,
      list: async (): Promise<readonly OwnedProcessIdentity[]> => {
        const mainPid = tree.child.pid!;
        return [
          { pid: mainPid, ppid: mainPpid, startedAtMs: 0, pgid: mainPid },
          // pgid follows the parent, never the pid: the kill stays a single-pid signal.
          ...entries(mainPid).map((entry) => ({ pgid: entry.ppid, ...entry })),
        ];
      },
    },
  }).spawn(["sleep", "30"], tmpdir(), env);
  spawned.push(tree.child);
  return {
    tree,
    add: (child: { kill(signal?: "SIGKILL"): void; exited: Promise<unknown> }) =>
      spawned.push(child),
    cleanup: async () => {
      for (const child of spawned) child.kill("SIGKILL");
      await Promise.all(spawned.map((child) => child.exited.catch(() => {})));
    },
  };
}

test.skipIf(process.platform === "win32")(
  "killTurnDescendants kills only descendants inside the turn window, never the main process",
  async () => {
    const inWindow = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const tooOld = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const afterEnd = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const { tree, add, cleanup } = await fixture((mainPid) => [
      { pid: inWindow.pid!, ppid: mainPid, startedAtMs: 11_000 },
      { pid: tooOld.pid!, ppid: mainPid, startedAtMs: 9_000 },
      { pid: afterEnd.pid!, ppid: mainPid, startedAtMs: 20_000 },
    ]);
    add(inWindow);
    add(tooOld);
    add(afterEnd);
    try {
      // The fence rounds down to the table's one-second resolution: 10_500 → 10_000.
      const report = await tree.killTurnDescendants!(10_500, 15_000);
      expect(report.killed).toEqual([inWindow.pid]);
      expect([...report.leftAlone].sort()).toEqual([tooOld.pid, afterEnd.pid].sort());
      await inWindow.exited;
      expect(inWindow.killed).toBe(true);
      expect(tooOld.killed).toBe(false);
      expect(afterEnd.killed).toBe(false);
      // The main process itself is never a descendant: it is still running.
      expect(tree.child.exitCode).toBeNull();
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "killTurnDescendants reports nothing when the main process is not the daemon's child",
  async () => {
    const inWindow = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    // The table's main row names a different parent — a recycled or foreign pid is not ours.
    const { tree, add, cleanup } = await fixture(
      (mainPid) => [{ pid: inWindow.pid!, ppid: mainPid, startedAtMs: 11_000 }],
      1,
    );
    add(inWindow);
    try {
      const report = await tree.killTurnDescendants!(10_000);
      expect(report).toEqual({ killed: [], leftAlone: [] });
      expect(inWindow.killed).toBe(false);
      expect(tree.child.exitCode).toBeNull();
    } finally {
      await cleanup();
    }
  },
);
