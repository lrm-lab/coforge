import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupInstallerFixtures,
  run,
  serveStub,
  temporaryDirectories,
} from "./installer-script-runner";
import { subprocessTest } from "./subprocess-test";

afterEach(cleanupInstallerFixtures);

const target = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const installerPath = `/installer/0.1.0/${target}/coforge-installer.gz`;
const requests = [
  "/installer/latest",
  installerPath,
  `/installer/0.1.0/${target}/coforge-installer.sha256`,
];

function checksum(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function fakeInstaller(log: string, command: "repair" | "status", exit = 0) {
  return Buffer.from(
    `#!/bin/sh\n` +
      `[ "$#" -eq 1 ] && [ "$1" = ${command} ] || exit 90\n` +
      `printf '%s\\n' "$@" >> "${log}"\n` +
      `exit ${exit}\n`,
  );
}

async function fixture(options: { command: "repair" | "status"; exit?: number; log: string }) {
  const installer = fakeInstaller(options.log, options.command, options.exit);
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
    ["/installer/latest", Buffer.from("0.1.0\n")],
    [installerPath, Bun.gzipSync(installer)],
    [
      `/installer/0.1.0/${target}/coforge-installer.sha256`,
      Buffer.from(`${checksum(installer)}\n`),
    ],
  ]);
  const requested: string[] = [];
  const server = serveStub({
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      const body = files.get(path);
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, requested };
}

for (const command of ["repair", "status"] as const) {
  test(`install.sh forwards ${command} without install PATH work`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `coforge-${command}-`));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const served = await fixture({ command, log });
    const child = await run([command], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: served.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim()).toBe(command);
    expect(served.requested).toEqual(requests);
    expect(await readdir(child.home)).toEqual([]);
  });
}

subprocessTest("install.sh retries repair once on installer exit 3", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-repair-retry-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const served = await fixture({ command: "repair", exit: 3, log });
  const child = await run(["repair"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).toBe(3);
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["repair", "repair"]);
  expect(child.stderr).toContain("retrying installer once after exit 3");
});
