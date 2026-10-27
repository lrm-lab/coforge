import { expect, test } from "bun:test";

import { rejection } from "./rejection";
import { UpdateError } from "#src/updater";
import { createCoordinatorServiceRegistrar } from "#src/release/coordinator-service-registrar";
import type { VerifiedInstaller } from "#src/release/installer-launch";
import type { InstallerRun, InstallerSpawn } from "#src/release/upgrade-runner";

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

test("registerAndStart runs the installer's plain start with the terminal attached", async () => {
  const spawned: InstallerSpawn[] = [];
  await registrarWith({ exitCode: 0 }, spawned).registerAndStart();

  expect(spawned).toEqual([
    {
      path: "/install-root/installer/abc/coforge-installer",
      args: ["start"],
      stdin: "ignore",
      stdout: "inherit",
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
