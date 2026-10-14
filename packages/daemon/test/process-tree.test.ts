import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { ProcessTreeOwner } from "#src/platform/process-tree";
import { RuntimeExecutableNotFoundError } from "#src/platform/runtime-executable-not-found";

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
  { platform: "unix", create: () => ({ owner: new ProcessTreeOwner("linux"), job: undefined }) },
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
