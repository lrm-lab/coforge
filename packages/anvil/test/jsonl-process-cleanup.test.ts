import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { type OwnedProcessTree } from "@lrm/coforge-anvil";
import type { AgentSessionExit } from "@coforge/agent";

// A process whose tree cannot be torn down must still reach a terminal state and report itself
// closed exactly once: every adapter decides a session ended from `onClose`/`onExit`, so a
// cleanup that fails after a crash leaves the Agent looking alive forever (task #704).

type TreeBehaviour = {
  /** Whether the tree is gone when cleanup checks. `false` models the unslayable tree. */
  exitAfterTerminate: boolean;
  /** Emits an invalid JSONL line so the process fails itself, as a broken runtime does. */
  corruptOutput?: boolean;
};

function tree(behaviour: TreeBehaviour) {
  const calls = { terminate: 0, terminateForTurn: 0, stdinEnd: 0 };
  const encoder = new TextEncoder();
  const value: OwnedProcessTree = {
    child: {
      pid: 1,
      exited: Promise.resolve(1),
      exitCode: 1,
      stdin: {
        write: () => true,
        end: () => {
          calls.stdinEnd += 1;
        },
        flush: async () => undefined,
      },
      stdout: {
        async *[Symbol.asyncIterator]() {
          if (behaviour.corruptOutput) yield encoder.encode("not json\n");
        },
      },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => {
      calls.terminate += 1;
    },
    terminateForTurn: async () => {
      calls.terminateForTurn += 1;
      return { killed: [], leftAlone: [] };
    },
    waitForExit: async () => behaviour.exitAfterTerminate,
  };
  return { value, calls };
}

test("a process that fails itself closes even when its tree will not die", async () => {
  const { value } = tree({ exitAfterTerminate: false, corruptOutput: true });
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => value });
  const failures: string[] = [];
  const closes: number[] = [];
  process.onFailure((error) => failures.push(error.message));
  process.onClose(() => closes.push(1));
  // Without a close, an adapter waits on a session that ended long ago.
  await Bun.sleep(100);
  expect(closes).toHaveLength(1);
  // The failure is still reported, once, and names the reason.
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("invalid output");
  await process.dispose().catch(() => undefined);
  // Disposing afterwards neither re-reports the failure nor closes a second time.
  expect(failures).toHaveLength(1);
  expect(closes).toHaveLength(1);
});

test("a failing dispose still closes the process and reports the tree it left", async () => {
  const { value } = tree({ exitAfterTerminate: false });
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => value });
  const closes: number[] = [];
  const exits: (AgentSessionExit | undefined)[] = [];
  process.onClose((exit) => {
    closes.push(1);
    exits.push(exit);
  });
  await expect(process.dispose()).rejects.toThrow(/did not exit/i);
  // The tree survived that teardown. The close still stands, and the exit carries the fact so
  // the daemon refuses to replace it (#704).
  expect(exits).toHaveLength(1);
  expect(exits[0]?.cleanupUnconfirmed).toBe(true);
  // A later dispose is a no-op that does not reject: callers dispose from cancel handlers and
  // `finally` blocks, where a second rejection would escape as an unhandled one.
  await process.dispose();
  expect(closes).toHaveLength(1);
});

test("a dispose concurrent with a self-failure keeps the process's own failure as the reason", async () => {
  const { value } = tree({ exitAfterTerminate: false, corruptOutput: true });
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => value });
  const closes: number[] = [];
  const late: string[] = [];
  // A failure listener that tears the process down is exactly what the interrupt paths do, and
  // it races `#fail`'s own close. Whichever wins must report the same reason (#704).
  process.onFailure(() => void process.dispose().catch(() => undefined));
  process.onClose(() => closes.push(1));
  await Bun.sleep(100);
  expect(closes).toHaveLength(1);
  // Read after the close: a composite reason would no longer match the sentinel consumers
  // compare against, so the process's own failure must survive on its own.
  process.onFailure((error) => late.push(error.message));
  await Bun.sleep(10);
  expect(late).toEqual(["code agent process produced invalid output"]);
});

test("the exit a surviving tree reports says the cleanup was unconfirmed", async () => {
  const { value } = tree({ exitAfterTerminate: false });
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => value });
  // Every adapter passes the process's exit object straight through to the daemon, so the fact
  // rides there: the daemon refuses to replace a process it could not kill (#704).
  const exits: (AgentSessionExit | undefined)[] = [];
  process.onClose((exit) => exits.push(exit));
  await process.dispose().catch(() => undefined);
  expect(exits).toHaveLength(1);
  expect(exits[0]?.cleanupUnconfirmed).toBe(true);
});

test("an ordinary end reports no cleanup failure", async () => {
  const { value } = tree({ exitAfterTerminate: true });
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => value });
  const exits: (AgentSessionExit | undefined)[] = [];
  process.onClose((exit) => exits.push(exit));
  await process.dispose();
  expect(exits).toHaveLength(1);
  expect(exits[0]?.code).toBe(1);
  expect(exits[0]?.cleanupUnconfirmed).toBeUndefined();
});

test("the first cleanup decides the tree: a later turn cutoff does not redo it", async () => {
  const { value, calls } = tree({ exitAfterTerminate: false, corruptOutput: true });
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => value });
  await Bun.sleep(100);
  // The process failed itself, which already tore the whole tree down. A dispose that arrives
  // with a turn cutoff cannot narrow that: the tree was never selectively killed.
  await process.dispose({ cutoffAtMs: Date.now() }).catch(() => undefined);
  expect(calls.terminateForTurn).toBe(0);
  // The whole-tree ladder ran instead: the polite ask, then the forced escalation.
  expect(calls.terminate).toBe(2);
});
