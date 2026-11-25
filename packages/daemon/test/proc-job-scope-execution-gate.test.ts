import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDetachedProcJob } from "#src/platform/proc-job-process";
import { readProcJobScopeGroup } from "#src/platform/proc-job-systemd-memory";

test("a scope that did not acquire its memory limit cannot execute the user command", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const fixture = await scopeFixture();
  try {
    const start = spawnDetachedProcJob({
      ...fixture.input,
      verifySystemdMemoryScope: async () => false,
    });
    await expect(start).rejects.toThrow("Could not verify the scope memory limit");
    await fixture.exited;
    expect(await Bun.file(fixture.marker).exists()).toBe(false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function scopeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "coforge-proc-scope-gate-"));
  const marker = join(directory, "executed");
  const logPath = join(directory, "job.log");
  await writeFile(logPath, "", { mode: 0o600 });
  await writeFile(
    join(directory, "systemd-run"),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
    { mode: 0o700 },
  );
  const exited = Promise.withResolvers<void>();
  const payload = String.fromCharCode(36) + "{DO_NOT_EXPAND}";
  return {
    directory,
    marker,
    payload,
    exited: exited.promise,
    input: {
      cwd: directory,
      env: { PATH: `${directory}:/usr/bin:/bin`, DO_NOT_EXPAND: "expanded" },
      command: [
        process.execPath,
        "-e",
        "await Bun.write(Bun.argv[1], JSON.stringify([Bun.argv[2], await Bun.stdin.text()]))",
        marker,
        payload,
      ],
      logPath,
      scopeControl: {
        systemdRunPath: join(directory, "systemd-run"),
        systemctlPath: "/usr/bin/false",
        environment: { PATH: "/usr/bin:/bin" },
      },
      systemdUnit: "coforge-proc-fixture.scope",
      memoryLimitBytes: 4_294_967_296,
      onExit: () => exited.resolve(),
    },
  };
}

test("a verified scope releases the command exactly once with its original argument and closed stdin", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const fixture = await scopeFixture();
  const entered = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<boolean>();
  try {
    const start = spawnDetachedProcJob({
      ...fixture.input,
      verifySystemdMemoryScope: () => {
        entered.resolve();
        return verified.promise;
      },
    });
    await entered.promise;
    expect(await Bun.file(fixture.marker).exists()).toBe(false);
    verified.resolve(true);
    const { pid } = await start;
    expect(pid).toBeGreaterThan(1);
    await fixture.exited;
    expect(await Bun.file(fixture.marker).json()).toEqual([fixture.payload, ""]);
  } finally {
    verified.resolve(false);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a verifier that reports success after the deadline cannot release the scope", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const fixture = await scopeFixture();
  const verified = Promise.withResolvers<boolean>();
  try {
    let verificationSignal: AbortSignal | undefined;
    const start = spawnDetachedProcJob({
      ...fixture.input,
      verifyTimeoutMs: 40,
      verifySystemdMemoryScope: ({ signal }) => {
        verificationSignal = signal;
        return verified.promise;
      },
    });
    await expect(start).rejects.toThrow("Could not verify the scope memory limit");
    expect(verificationSignal?.aborted).toBe(true);
    verified.resolve(true);
    await fixture.exited;
    expect(await Bun.file(fixture.marker).exists()).toBe(false);
  } finally {
    verified.resolve(false);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("scope property read-back requires the requested identity and exact memory controls", () => {
  const unit = "coforge-proc-fixture.scope";
  const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
  const show = [
    "ActiveState=active",
    `ControlGroup=${group}`,
    "InvocationID=0123456789abcdef0123456789abcdef",
    "MemoryAccounting=yes",
    "MemoryMax=4294967296",
    "MemorySwapMax=0",
    "OOMPolicy=kill",
  ].join("\n");
  expect(readProcJobScopeGroup(show, unit, 4_294_967_296)).toBe(group);
  expect(readProcJobScopeGroup(show, "other.scope", 4_294_967_296)).toBeUndefined();
  expect(
    readProcJobScopeGroup(
      show.replace("MemoryMax=4294967296", "MemoryMax=infinity"),
      unit,
      4_294_967_296,
    ),
  ).toBeUndefined();
  expect(
    readProcJobScopeGroup(
      show.replace("MemorySwapMax=0", "MemorySwapMax=infinity"),
      unit,
      4_294_967_296,
    ),
  ).toBeUndefined();
  expect(
    readProcJobScopeGroup(
      show.replace("OOMPolicy=kill", "OOMPolicy=continue"),
      unit,
      4_294_967_296,
    ),
  ).toBeUndefined();
  expect(
    readProcJobScopeGroup(
      show.replace("ActiveState=active", "ActiveState=activating"),
      unit,
      4_294_967_296,
    ),
  ).toBeUndefined();
  expect(
    readProcJobScopeGroup(show + "\nMemoryAccounting=yes", unit, 4_294_967_296),
  ).toBeUndefined();
});

test("the capped scope starts with the daemon binary and environment", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const fixture = await scopeFixture();
  try {
    const controlDirectory = join(fixture.directory, "control");
    await mkdir(controlDirectory);
    const systemdRunPath = join(controlDirectory, "systemd-run");
    await writeFile(
      systemdRunPath,
      '#!/bin/sh\nprintf "control=%s\\n" "${PROBE_ENV-unset}"\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(fixture.directory, "systemd-run"),
      '#!/bin/sh\nprintf "request PATH selected\\n"\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o700 },
    );
    const scopeControl = {
      ...fixture.input.scopeControl,
      systemdRunPath,
      environment: { PATH: "/usr/bin:/bin", PROBE_ENV: "daemon" },
    };
    const { pid } = await spawnDetachedProcJob({
      ...fixture.input,
      scopeControl,
      env: { ...fixture.input.env, PROBE_ENV: "request" },
      command: [
        process.execPath,
        "-e",
        "await Bun.write(Bun.argv[1], JSON.stringify([Bun.env.PROBE_ENV, Bun.argv[2], await Bun.stdin.text(), process.pid, process.cwd()]))",
        fixture.marker,
        fixture.payload,
      ],
      verifySystemdMemoryScope: async () => true,
    });
    await fixture.exited;
    expect(await Bun.file(fixture.input.logPath).text()).toBe("control=daemon\n");
    expect(await Bun.file(fixture.marker).json()).toEqual([
      "request",
      fixture.payload,
      "",
      pid,
      await realpath(fixture.directory),
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
