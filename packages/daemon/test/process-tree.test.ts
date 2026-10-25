import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import type { OwnedProcessTreeKillReport } from "@lrm/coforge-anvil";
import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import { cleanupOwnedTree } from "#src/code-agent/process-tree-cleanup";
import { hostProcessTable, ProcessTreeOwner } from "#src/platform/process-tree";
import { RuntimeExecutableNotFoundError } from "#src/platform/runtime-executable-not-found";

// Inside a CoForge Workspace on macOS these route spawn through launchd; the host must not decide.
const workspaceAgentVariables = [
  "COFORGE_WORKSPACE_AGENT_PREFIX",
  "COFORGE_WORKSPACE_JOB_DIRECTORY",
] as const;
const hostWorkspaceAgentValues = workspaceAgentVariables.map((name) => process.env[name]);

beforeEach(() => {
  for (const name of workspaceAgentVariables) delete process.env[name];
});

afterEach(() => {
  workspaceAgentVariables.forEach((name, index) => {
    const value = hostWorkspaceAgentValues[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

test("spawn errors without an OS process fail synchronously", () => {
  const owner = new ProcessTreeOwner();
  expect(() =>
    owner.spawn([`coforge-missing-${crypto.randomUUID()}`], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    }),
  ).toThrow("Executable not found");
});

test("a runtime executable missing from the Agent's PATH fails as RuntimeExecutableNotFoundError", () => {
  const executable = `coforge-missing-${crypto.randomUUID()}`;
  let thrown: unknown;
  try {
    new ProcessTreeOwner().spawn([executable], tmpdir(), { PATH: "/usr/bin:/bin" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeExecutableNotFoundError);
  expect(thrown).toMatchObject({ code: "runtime_not_found", executable });
});

test("a missing working directory stays a plain ENOENT, not a missing runtime", () => {
  let thrown: unknown;
  try {
    new ProcessTreeOwner().spawn(["sh", "-c", "true"], "/nonexistent-coforge-cwd", {
      PATH: "/usr/bin:/bin",
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: "ENOENT" });
  expect(thrown).not.toBeInstanceOf(RuntimeExecutableNotFoundError);
});

test("Windows launch fails closed when Job Object creation is unavailable", () => {
  const owner = new ProcessTreeOwner("win32", undefined, {
    createJobObject: () => {
      throw new Error("no job objects in this test");
    },
  });
  expect(() =>
    owner.spawn([globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    }),
  ).toThrow("Windows Agent process isolation is unavailable");
});

test.skipIf(process.platform !== "win32")(
  "Windows Job Object terminate clears a live Agent child",
  async () => {
    const owner = new ProcessTreeOwner();
    const tree = owner.spawn(
      [globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"],
      tmpdir(),
      { PATH: globalThis.process.env.PATH ?? "" },
    );
    expect(tree.child.pid).toBeGreaterThan(0);
    await tree.terminate(true);
    expect(await tree.waitForExit(2_000)).toBe(true);
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows Job Object terminate clears a child that spawned a grandchild",
  async () => {
    const owner = new ProcessTreeOwner();
    const script = `
      Bun.spawn({
        cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      setInterval(() => {}, 1000);
    `;
    const tree = owner.spawn([globalThis.process.execPath, "-e", script], tmpdir(), {
      PATH: globalThis.process.env.PATH ?? "",
    });
    await Bun.sleep(300);
    await tree.terminate(true);
    expect(await tree.waitForExit(3_000)).toBe(true);
  },
);

/** Blocks the event loop so an exited child stays unreaped. `Bun.sleep` yields instead, which lets
 * the runtime reap the zombie before the test can observe it. */
function blockEventLoop(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Deliberate synchronous wait.
  }
}

test("a group whose only remaining member is a zombie counts as exited", async () => {
  const owner = new ProcessTreeOwner();
  const tree = owner.spawn([globalThis.process.execPath, "-e", "process.exit(0)"], tmpdir(), {
    PATH: globalThis.process.env.PATH ?? "",
  });
  // The child has exited but is still unreaped, so the group's only member is a zombie. macOS
  // answers EPERM - not ESRCH - for both `kill(-pgid, 0)` and `kill(-pgid, SIGKILL)` in exactly
  // that state, which used to surface as a thrown cleanup failure. The linux branch already
  // ignores zombies explicitly.
  blockEventLoop(300);
  expect(await tree.waitForExit(1_000)).toBe(true);
  await tree.terminate(true);
});

/** A Job Object stand-in, so the Windows launch path's child adapter runs on any platform. */
function fakeJobObject() {
  const job = {
    assigned: [] as number[],
    closed: 0,
    handle: 1n,
    assign: (processId: number) => void job.assigned.push(processId),
    terminate: () => {},
    activeProcesses: () => 0,
    close: () => void job.closed++,
  };
  return job;
}

/** Each call is a fresh owner, and on the Windows path a fresh Job Object to inspect. */
const childAdapterOwners = [
  {
    platform: "unix",
    // The host's Unix branch (Linux scans /proc, macOS probes with kill); Windows keeps Linux.
    create: () => ({
      owner: new ProcessTreeOwner(process.platform === "win32" ? "linux" : process.platform),
      job: undefined,
    }),
  },
  {
    platform: "win32 (fake Job Object)",
    create: () => {
      const job = fakeJobObject();
      return {
        owner: new ProcessTreeOwner("win32", undefined, { createJobObject: () => job }),
        job,
      };
    },
  },
] as const;

for (const { platform, create } of childAdapterOwners) {
  test(`${platform}: the owned child exposes the spawned process's pid, pipes and exit`, async () => {
    const { owner, job } = create();
    const tree = owner.spawn(["sh", "-c", 'read line; echo "got:$line"; exit 3'], tmpdir(), {
      PATH: "/usr/bin:/bin",
    });
    const { child } = tree;
    expect(child.pid).toBeGreaterThan(0);
    if (job) expect(job.assigned).toEqual([child.pid!]);
    expect(child.exitCode).toBeNull();
    expect(child.stdin.write("hello\n")).toBe(true);
    await child.stdin.flush();
    child.stdin.end();
    const stdout = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
    expect(await child.exited).toBe(3);
    expect(child.exitCode).toBe(3);
    expect(stdout).toBe("got:hello\n");
    expect(stderr).toBe("");
    expect(await tree.waitForExit(2_000)).toBe(true);
    if (job) expect(job.closed).toBe(1);
  });

  test(`${platform}: kill on the owned child signals the spawned process`, async () => {
    const { owner } = create();
    const tree = owner.spawn(["sh", "-c", "exec sleep 30"], tmpdir(), { PATH: "/usr/bin:/bin" });
    tree.child.kill("SIGKILL");
    await tree.child.exited;
    expect(tree.child.exitCode).not.toBe(0);
    await tree.terminate(true);
    expect(await tree.waitForExit(2_000)).toBe(true);
  });
}

test.skipIf(process.platform === "win32")(
  "turn-scoped termination only kills descendants started at or after the fence and guards PID reuse",
  async () => {
    const env = { PATH: "/usr/bin:/bin" };
    const decoy = () => Bun.spawn({ cmd: ["sleep", "30"], stdin: "ignore", env });
    const [older, current, reused] = [decoy(), decoy(), decoy()];
    const fence = 1_000_000;
    let mainPid = 0;
    let sampled = 0;
    const tree = new ProcessTreeOwner(undefined, undefined, {
      processTable: {
        list: async () => {
          const main = {
            pid: mainPid,
            ppid: globalThis.process.pid,
            startedAtMs: fence - 1,
          };
          const table = [
            main,
            { pid: older.pid, ppid: main.pid, startedAtMs: fence - 1 },
            { pid: current.pid, ppid: main.pid, startedAtMs: fence + 1 },
            // First sample is the turn's snapshot; by the force sample the pid belongs to a stranger.
            { pid: reused.pid, ppid: main.pid, startedAtMs: fence + 2 + sampled * 1_000 },
          ];
          sampled++;
          return table;
        },
      },
    }).spawn(["sleep", "30"], tmpdir(), env);
    mainPid = tree.child.pid!;

    expect(await tree.terminateForTurn!(false, fence)).toEqual({ killed: [], leftAlone: [] });
    const report = await tree.terminateForTurn!(true, fence);

    expect(report.killed).toContain(current.pid);
    expect(report.killed).toContain(tree.child.pid!);
    expect([...report.leftAlone].sort()).toEqual([older.pid, reused.pid].sort());
    await current.exited;
    expect(older.killed).toBe(false);
    expect(reused.killed).toBe(false);
    older.kill("SIGKILL");
    reused.kill("SIGKILL");
    await Promise.all([older.exited, reused.exited, tree.child.exited]);
  },
);

test.skipIf(process.platform === "win32")(
  "a turn interrupt SIGKILLs a main process that ignores SIGTERM after the grace, sparing earlier children",
  async () => {
    const tree = new ProcessTreeOwner().spawn(
      [
        "sh",
        "-c",
        // An earlier dev server, then (after the fence) this turn's child, then ignore SIGTERM.
        'trap "" TERM; sleep 60 & echo $!; sleep 2; sleep 60 & echo $!; while :; do sleep 1; done',
      ],
      tmpdir(),
      { PATH: "/usr/bin:/bin" },
    );
    const reader = (tree.child.stdout as ReadableStream<Uint8Array>).getReader();
    const pids: number[] = [];
    // The turn begins after the earlier child was reported and before the sleep ends.
    let fenceAtMs: number | undefined;
    let buffered = "";
    while (pids.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += new TextDecoder().decode(value);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      pids.push(...lines.map(Number));
      fenceAtMs ??= Date.now() + 1_500;
    }
    const [earlier, turnChild] = pids as [number, number];
    const reports: OwnedProcessTreeKillReport[] = [];
    const alive = (pid: number) => {
      try {
        globalThis.process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      await cleanupOwnedTree(tree, tree.child, {
        cutoffAtMs: fenceAtMs,
        onKillReport: (report) => reports.push(report),
      });
      expect(await tree.child.exited).not.toBe(0);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.killed).toContain(tree.child.pid!);
      expect(reports[0]!.killed).toContain(turnChild);
      expect(reports[0]!.leftAlone).toContain(earlier);
      expect(alive(turnChild)).toBe(false);
      expect(alive(earlier)).toBe(true);
    } finally {
      for (const pid of pids) if (alive(pid)) globalThis.process.kill(pid, "SIGKILL");
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "a turn interrupt does not report the tree exited while this turn's children ignore SIGTERM",
  async () => {
    const tree = new ProcessTreeOwner().spawn(
      [
        "sh",
        "-c",
        // The main process exits on SIGTERM; its child, started this turn, ignores it.
        "trap 'exit 0' TERM; (trap '' TERM; exec sleep 60) & echo $!; while :; do sleep 1; done",
      ],
      tmpdir(),
      { PATH: "/usr/bin:/bin" },
    );
    const reader = (tree.child.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const stubborn = Number(new TextDecoder().decode(value).trim());
    const reports: OwnedProcessTreeKillReport[] = [];
    try {
      await cleanupOwnedTree(tree, tree.child, {
        cutoffAtMs: Date.now() - 2_000,
        onKillReport: (report) => reports.push(report),
      });
      expect(reports[0]!.killed).toContain(stubborn);
      expect(await tree.waitForExit(1_000)).toBe(true);
    } finally {
      try {
        globalThis.process.kill(stubborn, "SIGKILL");
      } catch {}
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "the host process table parses start times whatever the system language",
  async () => {
    const before = process.env.LC_ALL;
    process.env.LC_ALL = "zh_CN.UTF-8";
    try {
      const own = (await hostProcessTable.list()).find((entry) => entry.pid === process.pid);
      expect(own).toBeDefined();
      expect(own!.startedAtMs).toBeLessThanOrEqual(Date.now());
      expect(own!.startedAtMs).toBeGreaterThan(Date.now() - 365 * 24 * 3_600_000);
    } finally {
      if (before === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = before;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a restart with no turn fence falls back to killing the whole tree, earlier children included",
  async () => {
    const tree = new ProcessTreeOwner().spawn(
      ["sh", "-c", "sleep 60 & echo $!; while :; do sleep 1; done"],
      tmpdir(),
      { PATH: "/usr/bin:/bin" },
    );
    const reader = (tree.child.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      const earlier = Number(new TextDecoder().decode((await reader.read()).value).trim());
      expect(Number.isSafeInteger(earlier) && earlier > 0).toBe(true);
      const reports: OwnedProcessTreeKillReport[] = [];
      await cleanupOwnedTree(tree, tree.child, { onKillReport: (report) => reports.push(report) });
      // No kill report: the whole-tree ladder ran, so nothing was filtered by the turn.
      expect(reports).toEqual([]);
      // macOS can finish group cleanup while the killed child is still in P_WEXIT. Wait for
      // that PID to disappear rather than assuming the kernel has already released it.
      const deadline = performance.now() + 2_000;
      for (;;) {
        try {
          globalThis.process.kill(earlier, 0);
        } catch (error) {
          if (hasErrorCode(error, "ESRCH")) break;
          throw error;
        }
        if (performance.now() >= deadline) {
          const state = Bun.spawnSync({
            cmd: ["ps", "-o", "pid=,ppid=,pgid=,stat=,command=", "-p", String(earlier)],
            stdout: "pipe",
            stderr: "pipe",
            timeout: 1_000,
          });
          throw new Error(
            `Child PID ${earlier} still exists 2000ms after cleanup (kill(pid, 0) succeeded): ${state.stdout.toString().trim()} ${state.stderr.toString().trim()}`,
          );
        }
        await Bun.sleep(10);
      }
    } finally {
      await tree.terminate(true);
      await tree.child.exited;
      await reader.cancel();
    }
  },
  20_000,
);
