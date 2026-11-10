import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import {
  AgentProcessCleanupError,
  PROCESS_OUTPUT_DRAIN_MS,
  type OwnedProcessTree,
} from "@lrm/coforge-anvil";

// A descendant that escaped the owned tree can keep stderr open after the tree itself is gone.
// Dispose must still settle: it reports an unconfirmed cleanup instead of waiting forever.

const DRAIN_MS = 30;

function treeWithOpenStderr(): OwnedProcessTree {
  return {
    child: {
      pid: 1,
      exited: Promise.resolve(0),
      exitCode: 0,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  };
}

test("pins the production drain bound", () => {
  expect(PROCESS_OUTPUT_DRAIN_MS).toBe(3_000);
});

test("dispose settles when a pipe stays open after the tree is gone, reporting the cleanup unconfirmed", async () => {
  const tree = treeWithOpenStderr();
  const process = new JsonlProcess(
    ["unused"],
    tmpdir(),
    {},
    { spawn: () => tree },
    undefined,
    undefined,
    DRAIN_MS,
  );
  const exits: Array<{ cleanupUnconfirmed?: boolean }> = [];
  process.onClose((exit) => exits.push(exit));

  await expect(process.dispose()).rejects.toBeInstanceOf(AgentProcessCleanupError);

  expect(exits).toHaveLength(1);
  expect(exits[0]?.cleanupUnconfirmed).toBe(true);
});
