import { expect, test } from "bun:test";
import { type OwnedProcessTree } from "@lrm/coforge-anvil";
import { cleanupOwnedTree } from "#src/process-tree-cleanup";
import { captureDaemonLogs } from "./fixtures/log-capture";

/**
 * The whole-tree ladder says what it is doing, and an idle Agent's restart takes it every time:
 * there is no turn to scope to, so the line it leaves is routine and belongs at info. A fence the
 * runtime should have had but lost is the warning (task #35).
 */
function tree(options: { turnScoped: boolean }): OwnedProcessTree {
  return {
    child: {
      pid: 1,
      exited: Promise.resolve(1),
      exitCode: 0,
      stdin: { write: () => true, end: () => {}, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => {},
    ...(options.turnScoped
      ? {
          terminateForTurn: async () => ({ killed: [], leftAlone: [] }),
        }
      : {}),
    waitForExit: async () => true,
  } as unknown as OwnedProcessTree;
}

async function cleanupLines(
  options: { turnScoped: boolean },
  cutoffAtMs: number | undefined,
): Promise<{ level: string; reason: unknown }[]> {
  const owned = tree(options);
  const { records } = await captureDaemonLogs(async () => {
    await cleanupOwnedTree(owned, owned.child, cutoffAtMs === undefined ? {} : { cutoffAtMs });
  }, "debug");
  return records
    .filter((record) => record.properties.event === "process_tree_cleanup:whole_tree")
    .map((record) => ({ level: record.level, reason: record.properties.reason }));
}

test("a restart with no turn fence reports the whole-tree ladder at info", async () => {
  expect(await cleanupLines({ turnScoped: true }, undefined)).toEqual([
    { level: "info", reason: "no_turn_fence" },
  ]);
});

test("a turn fence with no turn-scoped owner to use still reports a warning", async () => {
  expect(await cleanupLines({ turnScoped: false }, 1_000)).toEqual([
    { level: "warning", reason: "no_turn_scoped_owner" },
  ]);
});

test("a turn-scoped cleanup says nothing about the whole tree", async () => {
  expect(await cleanupLines({ turnScoped: true }, 1_000)).toEqual([]);
});
