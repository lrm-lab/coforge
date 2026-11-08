import { expect, test } from "bun:test";

import { runCli } from "#src/cli";

// The lifecycle commands that start, stop, restart and detach this Computer. Split out of
// `cli.test.ts` to keep that file clear of the gate, along the seam the commands themselves
// have: these dispatch through `DaemonCommand`, the file next door covers setup, status and
// upgrade.

test("restart --supervisor dispatches to restartSupervisor instead of the ordinary restart", async () => {
  const calls: string[] = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      async start() {},
      async stop() {},
      async restart() {
        calls.push("restart");
      },
      async detach() {
        return { kind: "detached" as const, workspaceSlug: "w" };
      },
      async restartSupervisor() {
        calls.push("restartSupervisor");
      },
    },
  };

  expect(await runCli(["restart", "--supervisor"], dependencies)).toBe(0);
  expect(calls).toEqual(["restartSupervisor"]);

  expect(await runCli(["restart"], dependencies)).toBe(0);
  expect(calls).toEqual(["restartSupervisor", "restart"]);
});

test("restart --supervisor and --workspace are mutually exclusive", async () => {
  const stderr: string[] = [];
  const calls: string[] = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      async start() {},
      async stop() {},
      async restart() {
        calls.push("restart");
      },
      async detach() {
        return { kind: "detached" as const, workspaceSlug: "w" };
      },
      async restartSupervisor() {
        calls.push("restartSupervisor");
      },
    },
  };

  const exitCode = await runCli(["restart", "--supervisor", "--workspace", "a"], dependencies, {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });

  expect(exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(stderr.join("\n")).toContain("RESTART_CONFLICTING_TARGET");
});

test("restart --supervisor is unavailable without a wired dependency", async () => {
  const stderr: string[] = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      async start() {},
      async stop() {},
      async restart() {},
      async detach() {
        return { kind: "detached" as const, workspaceSlug: "w" };
      },
    },
  };

  const exitCode = await runCli(["restart", "--supervisor"], dependencies, {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });

  expect(exitCode).toBe(1);
  expect(stderr.join("\n")).toContain("Supervisor restart is unavailable in this build");
});

test("foreground runs the supervisor in the current process for external supervision", async () => {
  let calls = 0;
  const exitCode = await runCli(["foreground"], {
    login: { async run() {} },
    setup: { async run() {} },
    foreground: {
      async run() {
        calls += 1;
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(calls).toBe(1);
});

test("detach prints the revoked-key and not-attached outcomes", async () => {
  // A found-but-revoked key says revoked, not detached; a machine with nothing to detach says
  // so instead of claiming it detached (task #417).
  const detach = async (outcome: { kind: string; workspaceSlug?: string }) => {
    const stdout: string[] = [];
    await runCli(
      ["detach"],
      {
        login: { async run() {} },
        setup: { async run() {} },
        daemon: {
          async start() {},
          async stop() {},
          async restart() {},
          async detach() {
            return outcome as never;
          },
          async restartSupervisor() {},
        },
      },
      { stdout: (line) => stdout.push(line), stderr: () => {} },
    );
    return stdout;
  };

  expect(await detach({ kind: "key_revoked", workspaceSlug: "w" })).toEqual([
    "The key on this computer has already been revoked; detached 'w' locally.",
  ]);
  expect(await detach({ kind: "not_attached" })).toEqual([
    "This computer is not attached to that Workspace.",
  ]);
});
