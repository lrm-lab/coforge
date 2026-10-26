import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  cleanupInstallerFixtures,
  serveStub,
  temporaryDirectories,
} from "./installer-script-runner";
import { bootstrapRequests, serveFixture } from "./installer-script-fixture";

afterEach(cleanupInstallerFixtures);

/** The one part of install.ps1 the Windows CI job cannot exercise (it only parses and lints the
 * script) is run here under `pwsh`. mise provides the PowerShell 7 that `mise.toml` pins to the
 * tasks that run these tests. The script calls `curl.exe`, which only Windows has; a link of
 * that name to the host's curl stands in for it. A host without `pwsh` fails these tests, naming
 * the tool, rather than skipping them: a run that lacks it must not go green without ever
 * running the script. */
function requirePowerShell(): string {
  const path = Bun.which("pwsh");
  if (!path) {
    throw new Error(
      "`pwsh` (PowerShell 7) is not on PATH, and these tests run install.ps1 under it. " +
        "Run them through `mise run test:computer` (or `mise run test`), which installs the " +
        "PowerShell 7 that mise.toml pins.",
    );
  }
  return path;
}

const powershellScript = resolve(import.meta.dir, "../../../scripts/release/install.ps1");

async function runPowerShell(
  args: string[],
  feedUrl: string,
): Promise<{ exitCode: number; stderr: string }> {
  const pwsh = requirePowerShell();
  const shims = await mkdtemp(join(tmpdir(), "coforge-curl-exe-"));
  temporaryDirectories.push(shims);
  if (process.platform !== "win32") await symlink(Bun.which("curl")!, join(shims, "curl.exe"));
  const environment: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${shims}${delimiter}${process.env.PATH ?? ""}`,
    COFORGE_RELEASE_FEED_URL: feedUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    // Loopback must not reach a proxy the host happens to configure.
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
  };
  for (const name of ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"])
    delete environment[name];
  const child = Bun.spawn({
    cmd: [pwsh, "-NoProfile", "-NonInteractive", "-File", powershellScript, ...args],
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

test("install.ps1's installer phase downloads only the target's coforge-installer gzip", async () => {
  for (const [target, object] of [
    ["linux-x64", "coforge-installer.gz"],
    ["darwin-arm64", "coforge-installer.gz"],
    ["windows-arm64", "coforge-installer.exe.gz"],
    ["windows-x64", "coforge-installer.exe.gz"],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
    temporaryDirectories.push(directory);
    const requested: string[] = [];
    const server = serveStub({
      fetch(request) {
        const path = new URL(request.url).pathname;
        requested.push(path);
        return path === `/installer/0.1.0/${target}/${object}`
          ? new Response("installer bytes")
          : new Response("not found", { status: 404 });
      },
    });

    const child = await runPowerShell(
      [
        "-PrepareDirectory",
        directory,
        "-Version",
        "0.1.0",
        "-Target",
        target,
        "-PreparePhase",
        "installer",
        "-QuietHeader",
      ],
      `http://127.0.0.1:${server.port}/installer`,
    );

    expect(child.stderr).toContain("==> Downloading CoForge installer");
    expect(child.exitCode).toBe(0);
    expect(requested).toEqual([`/installer/0.1.0/${target}/${object}`]);
    expect(await readdir(directory)).toEqual([object]);
    expect(await Bun.file(join(directory, object)).text()).toBe("installer bytes");
  }
}, 30000);

test("install.ps1's installer phase needs a preparation directory and refuses redirects", async () => {
  const requested: string[] = [];
  const server = serveStub({
    fetch(request) {
      requested.push(new URL(request.url).pathname);
      return new Response("installer bytes", {
        status: 302,
        headers: { Location: "/elsewhere" },
      });
    },
  });
  const feedUrl = `http://127.0.0.1:${server.port}/installer`;
  const common = ["-Version", "0.1.0", "-Target", "linux-x64", "-PreparePhase", "installer"];

  const withoutDirectory = await runPowerShell(common, feedUrl);
  expect(withoutDirectory.exitCode).not.toBe(0);
  expect(requested).toEqual([]);

  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const redirected = await runPowerShell(["-PrepareDirectory", directory, ...common], feedUrl);
  expect(redirected.exitCode).not.toBe(0);
  expect(redirected.stderr).toContain("HTTP 302");
  expect(requested).toEqual(["/installer/0.1.0/linux-x64/coforge-installer.gz"]);
}, 30000);

test("install.ps1 bootstrap fetches only the installer pointer, gzip and sidecar", async () => {
  // Running the extracted installer is not asserted here: pwsh on a non-Windows host cannot execute
  // an unmarked gzip payload (macOS hands it to LaunchServices), and no Windows runner exists yet.
  // The install.sh tests pin the arguments and exit status the bootstrap passes to the installer.
  const fixture = await serveFixture();
  const child = await runPowerShell(
    ["-Version", "3.2.1", "-Target", fixture.target],
    fixture.baseUrl,
  );
  expect(fixture.requested).toEqual(bootstrapRequests(fixture.target));
  expect(child.stderr).toContain("==> Downloading CoForge installer");
  expect(child.stderr).not.toContain("Downloading CoForge Computer");
  expect(child.stderr).not.toContain("failed its checksum check");
}, 30000);

test("install.ps1 bootstrap refuses a checksum mismatch, a redirect and an oversized pointer", async () => {
  const cases: Array<
    [name: string, options: Parameters<typeof serveFixture>[0], expected: string]
  > = [
    ["a checksum mismatch", { tamperInstallerChecksum: true }, "failed its checksum check"],
    ["a redirected pointer", { redirectPaths: ["/installer/latest"] }, "HTTP 302"],
    [
      "an oversized pointer",
      { objects: { "/installer/latest": Buffer.alloc(5000, 0x61) } },
      "curl exit code 63",
    ],
  ];
  for (const [name, options, expected] of cases) {
    const fixture = await serveFixture(options);
    const child = await runPowerShell(["-Target", fixture.target], fixture.baseUrl);
    expect(child.exitCode, name).not.toBe(0);
    expect(child.stderr, name).toContain(expected);
  }
}, 60000);
