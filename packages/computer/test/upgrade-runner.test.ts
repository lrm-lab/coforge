import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";

import { UpdateError } from "#src/updater";
import {
  defaultSpawnInstaller,
  runInstallerRecovery,
  runInstallerRepair,
  runUpgradeOperation,
  type InstallerSpawn,
  type UpgradeRunnerOptions,
} from "#src/release/upgrade-runner";
import { UpgradeFailedError } from "#src/release/upgrade-receipt";
import { parseRemoteUpgradeOperation, type UpgradeOperation } from "#src/release/upgrade-operation";
import { subprocessTest } from "./subprocess-test";

const runner = join(import.meta.dir, "..", "src", "release", "upgrade-runner.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A stand-in installer: a shell script that records its argv in `args.txt`, optionally prints to
 * stdout and stderr, optionally writes a receipt (`__ID__` is replaced by the request id it was
 * given), and exits with the chosen code.
 */
async function fakeInstaller(
  directory: string,
  behaviour: {
    exitCode: number;
    receipt?: Record<string, unknown>;
    stdout?: string;
    stderr?: string;
  },
): Promise<string> {
  const path = join(directory, "coforge-installer");
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" > ${shellQuote(join(directory, "args.txt"))}`];
  if (behaviour.stdout) lines.push(`printf '%s\\n' ${shellQuote(behaviour.stdout)}`);
  if (behaviour.stderr) lines.push(`printf '%s\\n' ${shellQuote(behaviour.stderr)} >&2`);
  if (behaviour.receipt) {
    const body = JSON.stringify(behaviour.receipt).replaceAll("__ID__", "@ID@");
    lines.push(
      `mkdir -p ${shellQuote(join(directory, "upgrade-results"))}`,
      `printf '%s' ${shellQuote(body)} | sed "s/@ID@/$3/" > ${shellQuote(join(directory, "upgrade-results"))}/"$3".result.json`,
    );
  }
  lines.push(`exit ${behaviour.exitCode}`, "");
  await writeFile(path, lines.join("\n"), { mode: 0o700 });
  return path;
}

function operation(origin: UpgradeOperation["origin"] = "cli"): UpgradeOperation {
  return { requestId: crypto.randomUUID(), selection: "9.9.9", origin };
}

function runnerOptions(
  installRoot: string,
  installer: string,
  overrides: Partial<UpgradeRunnerOptions> = {},
): Partial<UpgradeRunnerOptions> {
  return {
    installRoot,
    target: "linux-x64",
    feedUrl: "https://releases.example.invalid/",
    obtainInstaller: async () => ({ path: installer, version: "9.9.9" }),
    writeStderr: () => {},
    ...overrides,
  };
}

function receiptOf(requestId: string, fields: Record<string, unknown>) {
  return {
    schema_version: 1,
    request_id: requestId,
    operation: "upgrade",
    protocol: "coforge-installer/v1",
    installer_version: "9.9.9",
    ...fields,
  };
}

test("a succeeded installer receipt is returned", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, {
    exitCode: 0,
    receipt: receiptOf("__ID__", {
      status: "succeeded",
      exit_code: 0,
      version: "9.9.9",
      supervisorRunning: true,
      runtimes: [{ bindingId: "w1", running: true }],
    }),
  });

  const result = await runUpgradeOperation(op, runnerOptions(directory, installer));

  expect(result).toMatchObject({ status: "succeeded", version: "9.9.9", request_id: op.requestId });
});

test("the installer runs as `upgrade` with this process as the caller", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, {
    exitCode: 0,
    receipt: receiptOf("__ID__", { status: "succeeded", exit_code: 0, version: "9.9.9" }),
  });

  await runUpgradeOperation(op, runnerOptions(directory, installer));

  expect((await readFile(join(directory, "args.txt"), "utf8")).trim()).toBe(
    `upgrade --request-id ${op.requestId} --version 9.9.9 --caller-pid ${process.pid}`,
  );
});

test("a rolled-back receipt is thrown as an UpgradeFailedError carrying that receipt", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, {
    exitCode: 1,
    receipt: receiptOf("__ID__", {
      status: "failed",
      exit_code: 1,
      error: "probe failed",
      errorCode: UPGRADE_ERROR_CODE.ROLLED_BACK,
      restoredVersion: "1.0.0",
    }),
  });

  const error = await runUpgradeOperation(op, runnerOptions(directory, installer)).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(UpgradeFailedError);
  expect((error as UpgradeFailedError).message).toBe("probe failed");
  expect((error as UpgradeFailedError).result).toMatchObject({
    status: "failed",
    errorCode: UPGRADE_ERROR_CODE.ROLLED_BACK,
    restoredVersion: "1.0.0",
  });
});

test("exit 2 without a receipt writes a failed receipt, names the last stderr line, and throws it", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, {
    exitCode: 2,
    stderr: "an earlier line\nthe upgrade is held",
  });

  const error = await runUpgradeOperation(op, runnerOptions(directory, installer)).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(UpgradeFailedError);
  const written = JSON.parse(
    await readFile(join(directory, "upgrade-results", `${op.requestId}.result.json`), "utf8"),
  );
  expect(written).toEqual({
    schema_version: 1,
    request_id: op.requestId,
    operation: "upgrade",
    status: "failed",
    error: "the upgrade is held",
  });
  expect((error as UpgradeFailedError).result).toEqual(written);
});

test("an installer that exits without a receipt and with no stderr names its exit code", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, { exitCode: 3 });

  await expect(runUpgradeOperation(op, runnerOptions(directory, installer))).rejects.toThrow(
    "coforge-installer exited 3 without a receipt",
  );
  const written = JSON.parse(
    await readFile(join(directory, "upgrade-results", `${op.requestId}.result.json`), "utf8"),
  );
  expect(written).toMatchObject({
    status: "failed",
    error: "coforge-installer exited 3 without a receipt",
  });
});

test("an existing receipt is never overwritten by the fallback", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, {
    exitCode: 2,
    receipt: receiptOf("__ID__", { status: "held", exit_code: 2, error: "from the installer" }),
  });
  const path = join(directory, "upgrade-results", `${op.requestId}.result.json`);

  const error = await runUpgradeOperation(op, runnerOptions(directory, installer)).catch(
    (caught: unknown) => caught,
  );

  expect((error as UpgradeFailedError).result.error).toBe("from the installer");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    status: "held",
    error: "from the installer",
  });
  expect((await readdir(join(directory, "upgrade-results"))).length).toBe(1);
});

test("an installer that cannot be obtained writes a failed receipt carrying the UpdateError code", async () => {
  const directory = await scratch();
  const op = operation();

  const error = await runUpgradeOperation(op, {
    installRoot: directory,
    target: "linux-x64",
    feedUrl: "https://releases.example.invalid/",
    writeStderr: () => {},
    obtainInstaller: async () => {
      throw new UpdateError("UPDATE_FEED_INVALID", "installer/latest is missing");
    },
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(UpgradeFailedError);
  const written = JSON.parse(
    await readFile(join(directory, "upgrade-results", `${op.requestId}.result.json`), "utf8"),
  );
  expect(written).toEqual({
    schema_version: 1,
    request_id: op.requestId,
    operation: "upgrade",
    status: "failed",
    error: "installer/latest is missing",
    errorCode: "UPDATE_FEED_INVALID",
  });
});

test("a remote operation does not inherit stdout, while a CLI operation does", async () => {
  const directory = await scratch();
  const installer = await fakeInstaller(directory, {
    exitCode: 0,
    receipt: receiptOf("__ID__", { status: "succeeded", exit_code: 0, version: "9.9.9" }),
    stdout: "==> progress",
  });
  const spawned: InstallerSpawn[] = [];
  const recording = async (spawn: InstallerSpawn) => {
    spawned.push(spawn);
    return defaultSpawnInstaller(spawn);
  };

  await runUpgradeOperation(
    operation("remote"),
    runnerOptions(directory, installer, { spawnInstaller: recording }),
  );
  await runUpgradeOperation(
    operation("cli"),
    runnerOptions(directory, installer, { spawnInstaller: recording }),
  );

  expect(spawned.map((spawn) => spawn.stdout)).toEqual(["pipe", "inherit"]);
  expect(spawned.every((spawn) => spawn.stdin === "ignore")).toBe(true);
});

subprocessTest(
  "the default runner paths come from the home directory and name the install root and target",
  async () => {
    const { HOME: _home, ...environment } = Bun.env;
    // Asynchronous, so a slow start of the fresh Bun process does not freeze the test runner's own
    // timer; the failure message carries what the process said instead of a bare JSON parse error.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const { resolveUpgradeRunnerPaths } = await import(${JSON.stringify(runner)});
       console.log(JSON.stringify(resolveUpgradeRunnerPaths()));`,
      ],
      env: { ...environment, USERPROFILE: "/not/the/home/directory", XDG_BIN_HOME: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const paths = JSON.parse(stdout);
    expect(paths.installRoot).toBe(join(homedir(), ".coforge", "computer", "install"));
    expect(paths.target).toBeString();
  },
);

test("the receipt directory is created private", async () => {
  const directory = await scratch();
  const op = operation();
  const installer = await fakeInstaller(directory, { exitCode: 2 });
  await runUpgradeOperation(op, runnerOptions(directory, installer)).catch(() => {});
  const mode = (await stat(join(directory, "upgrade-results"))).mode & 0o777;
  expect(mode).toBe(0o700);
});

test("recover runs the installer's recover with this process as the caller, stdio attached, and returns its status", async () => {
  const directory = await scratch();
  const installer = await fakeInstaller(directory, { exitCode: 2 });
  const spawned: InstallerSpawn[] = [];
  const status = await runInstallerRecovery(
    runnerOptions(directory, installer, {
      spawnInstaller: async (spawn) => {
        spawned.push(spawn);
        return defaultSpawnInstaller(spawn);
      },
    }),
  );

  expect(status).toBe(2);
  expect(spawned).toEqual([
    {
      path: installer,
      args: ["recover", "--caller-pid", String(process.pid)],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  ]);
});

test("repair runs the installer's repair with stdio attached and returns its status", async () => {
  const directory = await scratch();
  const installer = await fakeInstaller(directory, { exitCode: 3 });
  const spawned: InstallerSpawn[] = [];
  const status = await runInstallerRepair(
    runnerOptions(directory, installer, {
      spawnInstaller: async (spawn) => {
        spawned.push(spawn);
        return defaultSpawnInstaller(spawn);
      },
    }),
  );

  expect(status).toBe(3);
  expect(spawned).toEqual([
    { path: installer, args: ["repair"], stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  ]);
});

test("only a CLI operation that allows a downgrade passes --allow-downgrade to the installer", async () => {
  const directory = await scratch();
  const installer = await fakeInstaller(directory, {
    exitCode: 0,
    receipt: receiptOf("__ID__", { status: "succeeded", exit_code: 0, version: "9.9.9" }),
  });
  const spawned: InstallerSpawn[] = [];
  const recording = async (spawn: InstallerSpawn) => {
    spawned.push(spawn);
    return defaultSpawnInstaller(spawn);
  };
  const allowed = { ...operation("cli"), allowDowngrade: true };
  const refused = operation("cli");
  const remote = parseRemoteUpgradeOperation([
    "__remote-upgrade",
    "--request-id",
    crypto.randomUUID(),
    "--version",
    "9.9.9",
    "--allow-downgrade",
  ]);

  await runUpgradeOperation(
    allowed,
    runnerOptions(directory, installer, { spawnInstaller: recording }),
  );
  await runUpgradeOperation(
    refused,
    runnerOptions(directory, installer, { spawnInstaller: recording }),
  );
  await runUpgradeOperation(
    remote,
    runnerOptions(directory, installer, { spawnInstaller: recording }),
  );

  expect(spawned.map((spawn) => spawn.args.includes("--allow-downgrade"))).toEqual([
    true,
    false,
    false,
  ]);
  expect(spawned[0]?.args).toEqual([
    "upgrade",
    "--request-id",
    allowed.requestId,
    "--version",
    "9.9.9",
    "--caller-pid",
    String(process.pid),
    "--allow-downgrade",
  ]);
});
