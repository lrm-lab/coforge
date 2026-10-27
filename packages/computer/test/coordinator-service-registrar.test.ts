import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rejection } from "./rejection";
import { UpdateError } from "#src/updater";
import { createCoordinatorServiceRegistrar } from "#src/release/coordinator-service-registrar";
import type { VerifiedInstaller } from "#src/release/installer-launch";
import type { InstallerRun, InstallerSpawn } from "#src/release/upgrade-runner";
import { subprocessTest } from "./subprocess-test";

function registrarWith(
  run: Partial<InstallerRun>,
  spawned: InstallerSpawn[] = [],
  installer: VerifiedInstaller = {
    path: "/install-root/installer/abc/coforge-installer",
    version: "0.2.0",
  },
) {
  return createCoordinatorServiceRegistrar({
    installRoot: "/install-root",
    target: "linux-x64",
    feedUrl: "https://releases.example.invalid/",
    obtainInstaller: async () => installer,
    spawnInstaller: async (spawn) => {
      spawned.push(spawn);
      return { exitCode: 0, stdout: "", stderr: "", ...run };
    },
  });
}

test("registerAndStart runs the installer's plain start, its progress sent to stderr", async () => {
  const spawned: InstallerSpawn[] = [];
  await registrarWith({ exitCode: 0 }, spawned).registerAndStart();

  expect(spawned).toEqual([
    {
      path: "/install-root/installer/abc/coforge-installer",
      args: ["start"],
      stdin: "ignore",
      stdout: "stderr",
      stderr: "pipe",
    },
  ]);
});

test("a held machine lock fails with the installer's own message", async () => {
  const message =
    "coforge-installer: another install, upgrade, recovery, or repair is running. Nothing was changed.";
  await expect(
    registrarWith({ exitCode: 2, stderr: `${message}\n` }).registerAndStart(),
  ).rejects.toThrow(message);
});

test("a failure without a message names the installer's exit status", async () => {
  await expect(registrarWith({ exitCode: 1 }).registerAndStart()).rejects.toThrow(
    "coforge-installer start exited 1",
  );
});

test("a failure of the cached installer says to connect so the current one can be fetched", async () => {
  const error = await rejection(
    registrarWith({ exitCode: 1, stderr: "coforge-installer: something went wrong\n" }, [], {
      path: "/install-root/installer/abc/coforge-installer",
    }).registerAndStart(),
  );

  expect(error.message).toContain("coforge-installer: something went wrong");
  expect(error.message).toContain(
    "ran the cached installer; connect to the network so the current installer can be fetched",
  );
});

test("a failure of a freshly fetched installer is reported as the installer said it", async () => {
  const error = await rejection(
    registrarWith({
      exitCode: 1,
      stderr: "coforge-installer: unknown command: start\n",
    }).registerAndStart(),
  );

  expect(error.message).toBe("coforge-installer: unknown command: start");
});

test("an installer that cannot be obtained fails with that error and spawns nothing", async () => {
  const spawned: InstallerSpawn[] = [];
  const unreachable = new UpdateError("UPDATE_DOWNLOAD_FAILED", "feed unreachable");
  const registrar = createCoordinatorServiceRegistrar({
    installRoot: "/install-root",
    target: "linux-x64",
    feedUrl: "https://releases.example.invalid/",
    obtainInstaller: async () => {
      throw unreachable;
    },
    spawnInstaller: async (spawn) => {
      spawned.push(spawn);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await expect(registrar.registerAndStart()).rejects.toBe(unreachable);
  expect(spawned).toEqual([]);
});

subprocessTest(
  "the installer's progress reaches the Computer's stderr and nothing reaches its stdout",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-registrar-"));
    try {
      const installer = join(directory, "installer.sh");
      await writeFile(installer, '#!/bin/sh\necho "==> Registering the service"\nexit 0\n');
      await chmod(installer, 0o755);

      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "registrar-subprocess.ts"), installer],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("==> Registering the service");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
