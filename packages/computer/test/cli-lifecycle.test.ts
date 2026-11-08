import { expect, test } from "bun:test";

import { runCli } from "#src/cli";

// The lifecycle commands that start, stop, restart and detach this Computer. Split out of
// `cli.test.ts` to stay under the file-size gate, along the seam the commands themselves have:
// these dispatch through `DaemonCommand`, the file next door covers setup, status and upgrade.

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

test("detach prints the outcome for a person, one sentence per case", async () => {
  // A found-but-revoked key says revoked, not detached; a machine with nothing to detach says
  // so instead of claiming it detached (task #417). The human path is asserted whole here
  // because `--json` now branches off the same outcomes: a sentence that changed while the JSON
  // was added would otherwise go unnoticed.
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

  expect(await detach({ kind: "detached", workspaceSlug: "w" })).toEqual(["Detached 'w'."]);
  expect(await detach({ kind: "key_revoked", workspaceSlug: "w" })).toEqual([
    "The key on this computer has already been revoked; detached 'w' locally.",
  ]);
  expect(await detach({ kind: "unconfirmed", workspaceSlug: "w" })).toEqual([
    "The server could not confirm detaching 'w'; the local registration was kept.",
  ]);
  expect(await detach({ kind: "not_bound", workspaceSlug: "w" })).toEqual([
    "'w' is not bound on this machine's supervisor; the local registration was kept.",
  ]);
  expect(await detach({ kind: "not_attached" })).toEqual([
    "This computer is not attached to that Workspace.",
  ]);
});

test("detach --json writes one JSON object and no prose", async () => {
  // `--json` is documented as one stable JSON result; the prose is for a person. A caller that
  // parses stdout cannot skip a sentence, and `stop --json` already answers in JSON only, so a
  // sibling command mixing them is a contract of its own (task #696).
  const detach = async (outcome: { kind: string; workspaceSlug?: string }) => {
    const stdout: string[] = [];
    const code = await runCli(
      ["detach", "--json"],
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
    expect(code).toBe(0);
    return stdout;
  };

  const lines = await detach({ kind: "detached", workspaceSlug: "w" });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({
    ok: true,
    detached: true,
    kind: "detached",
    workspaceSlug: "w",
  });

  // A revoked key leaves only the local half behind: a re-attach under a newer key may still be
  // live, so `DetachOutcome` reports `key_revoked` rather than `detached`, and so does this.
  expect(JSON.parse((await detach({ kind: "key_revoked", workspaceSlug: "w" }))[0]!)).toEqual({
    ok: true,
    detached: false,
    kind: "key_revoked",
    workspaceSlug: "w",
  });
  // The server never confirmed, or the supervisor never bound it: the registration is still
  // there, so a parser must not read this as a completed detach.
  expect(JSON.parse((await detach({ kind: "unconfirmed", workspaceSlug: "w" }))[0]!)).toEqual({
    ok: true,
    detached: false,
    kind: "unconfirmed",
    workspaceSlug: "w",
  });
  expect(JSON.parse((await detach({ kind: "not_bound", workspaceSlug: "w" }))[0]!)).toEqual({
    ok: true,
    detached: false,
    kind: "not_bound",
    workspaceSlug: "w",
  });
  expect(JSON.parse((await detach({ kind: "not_attached" }))[0]!)).toEqual({
    ok: true,
    detached: false,
    kind: "not_attached",
  });
});
