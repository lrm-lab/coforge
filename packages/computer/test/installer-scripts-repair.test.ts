import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupInstallerFixtures, run, temporaryDirectories } from "./installer-script-runner";
import { bootstrapRequests, serveFixture } from "./installer-script-fixture";
import { subprocessTest } from "./subprocess-test";

afterEach(cleanupInstallerFixtures);

subprocessTest(
  "install.sh forwards repair to the fetched installer without install-only PATH work",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-repair-script-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const fixture = await serveFixture({
      argumentLog: log,
      expectedCommand: "repair",
      omitShim: true,
    });
    const child = await run(["repair"], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["repair"]);
    expect(fixture.requested).toEqual(bootstrapRequests(fixture.target));
    expect(await readdir(child.home)).toEqual([]);
  },
);

subprocessTest("install.sh retries an installer exit 3 once for repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-repair-retry-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const fixture = await serveFixture({
    argumentLog: log,
    expectedCommand: "repair",
    installerExitStatus: 3,
    omitShim: true,
    appendArgumentLog: true,
  });
  const child = await run(["repair"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).toBe(3);
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["repair", "repair"]);
  expect(child.stderr.match(/Downloading CoForge installer/g)?.length).toBe(1);
  expect(child.stderr).toContain("retrying installer once after exit 3");
});

for (const command of ["status", "recover"] as const) {
  test(`install.sh does not retry ${command} after installer exit 3`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `coforge-${command}-script-`));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const fixture = await serveFixture({
      argumentLog: log,
      expectedCommand: command,
      installerExitStatus: 3,
      omitShim: true,
      appendArgumentLog: true,
    });
    const child = await run([command], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).toBe(3);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([command]);
    expect(child.stderr).not.toContain("retrying installer once after exit 3");
  });
}
