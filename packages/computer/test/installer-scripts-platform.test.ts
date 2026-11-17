import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  cleanupInstallerFixtures,
  run,
  serveStub,
  temporaryDirectories,
} from "./installer-script-runner";
import { bootstrapRequests, serveFixture } from "./installer-script-fixture";
import { subprocessTest } from "./subprocess-test";

afterEach(cleanupInstallerFixtures);

const powershellScript = resolve(import.meta.dir, "../../../scripts/release/install.ps1");

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

async function writeExecutable(path: string, contents: string): Promise<string> {
  await Bun.write(path, contents);
  await chmod(path, 0o700);
  return path;
}

async function makeUnameShim(system: string, machine: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-uname-shim-"));
  temporaryDirectories.push(directory);
  await writeExecutable(
    join(directory, "uname"),
    `#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\\n' '${system}' ;;
  -m) printf '%s\\n' '${machine}' ;;
  *) exit 2 ;;
esac
`,
  );
  return directory;
}

async function runPowerShellWithEnv(
  args: string[],
  feedUrl: string,
  overrides: Record<string, string | undefined>,
  curlStubExitCode?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const pwsh = requirePowerShell();
  const shims = await mkdtemp(join(tmpdir(), "coforge-ps-platform-"));
  temporaryDirectories.push(shims);
  if (curlStubExitCode !== undefined) {
    const stubName = process.platform === "win32" ? "curl.cmd" : "curl.exe";
    const body =
      process.platform === "win32"
        ? `@echo off\r\nexit /b ${curlStubExitCode}\r\n`
        : `#!/bin/sh\nexit ${curlStubExitCode}\n`;
    await writeExecutable(join(shims, stubName), body);
  } else if (process.platform !== "win32") {
    await symlink(Bun.which("curl")!, join(shims, "curl.exe"));
  }
  const environment: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${shims}${delimiter}${process.env.PATH ?? ""}`,
    COFORGE_RELEASE_FEED_URL: feedUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
  };
  for (const name of [
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "PROCESSOR_ARCHITEW6432",
    "PROCESSOR_ARCHITECTURE",
  ]) {
    delete environment[name];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  const child = Bun.spawn({
    cmd: [pwsh, "-NoProfile", "-NonInteractive", "-File", powershellScript, ...args],
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

subprocessTest(
  "install.sh selects darwin-arm64 on Apple Silicon inside a Rosetta x86_64 shell and keeps darwin-x64 on Intel Macs",
  async () => {
    const unameDir = await makeUnameShim("Darwin", "x86_64");
    const sysctlDir = await mkdtemp(join(tmpdir(), "coforge-sysctl-shim-"));
    temporaryDirectories.push(sysctlDir);

    const appleSiliconSysctl = await writeExecutable(
      join(sysctlDir, "sysctl-arm64"),
      `#!/bin/sh
if [ "$1" = "-in" ] && [ "$2" = "hw.optional.arm64" ]; then
  printf '1\\n'
  exit 0
fi
exit 1
`,
    );
    const intelSysctl = await writeExecutable(
      join(sysctlDir, "sysctl-intel"),
      `#!/bin/sh
if [ "$1" = "-in" ] && [ "$2" = "hw.optional.arm64" ]; then
  printf '0\\n'
  exit 0
fi
exit 1
`,
    );

    const rosettaFixture = await serveFixture({ target: "darwin-arm64" });
    const rosetta = await run(["--version", rosettaFixture.version], {
      ...process.env,
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      COFORGE_RELEASE_FEED_URL: rosettaFixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
      COFORGE_INSTALLER_SYSCTL: appleSiliconSysctl,
    });
    expect(rosetta.exitCode).toBe(0);
    expect(rosetta.stderr).toContain("Detected platform: macOS (Apple Silicon)");
    expect(rosettaFixture.requested).toEqual(bootstrapRequests("darwin-arm64"));

    const intelFixture = await serveFixture({ target: "darwin-x64" });
    const intel = await run(["--version", intelFixture.version], {
      ...process.env,
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      COFORGE_RELEASE_FEED_URL: intelFixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
      COFORGE_INSTALLER_SYSCTL: intelSysctl,
    });
    expect(intel.exitCode).toBe(0);
    expect(intel.stderr).toContain("Detected platform: macOS (Intel)");
    expect(intelFixture.requested).toEqual(bootstrapRequests("darwin-x64"));

    const missingSysctlFixture = await serveFixture({ target: "darwin-x64" });
    const missingSysctl = await run(["--resolve-only", "--version", "3.2.1"], {
      ...process.env,
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      COFORGE_RELEASE_FEED_URL: missingSysctlFixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
      COFORGE_INSTALLER_SYSCTL: join(sysctlDir, "does-not-exist"),
    });
    expect(missingSysctl.exitCode).toBe(0);
    expect(missingSysctl.stderr).toContain("Detected platform: macOS (Intel)");
  },
);

subprocessTest("install.sh ignores COFORGE_INSTALLER_SYSCTL outside test mode", async () => {
  const unameDir = await makeUnameShim("Darwin", "x86_64");
  const markerDir = await mkdtemp(join(tmpdir(), "coforge-sysctl-guard-"));
  temporaryDirectories.push(markerDir);
  const marker = join(markerDir, "ran");
  const untrustedSysctl = await writeExecutable(
    join(markerDir, "sysctl-untrusted"),
    `#!/bin/sh\nprintf 'ran' > "${marker}"\nprintf '1\\n'\n`,
  );

  const child = await run(["--resolve-only", "--version", "3.2.1"], {
    ...process.env,
    PATH: `${unameDir}:${process.env.PATH ?? ""}`,
    COFORGE_RELEASE_FEED_URL: "https://127.0.0.1:1",
    COFORGE_INSTALLER_TEST_MODE: "",
    COFORGE_INSTALLER_SYSCTL: untrustedSysctl,
  });
  expect(child.exitCode).toBe(0);
  expect(await Bun.file(marker).exists()).toBe(false);
});

subprocessTest(
  "install.sh maps curl exit codes 35 and 60 to firewall and TLS-interception hints while preserving exit statuses",
  async () => {
    for (const [code, expectedSnippet] of [
      [35, "TLS handshake failed (curl exit code 35)"],
      [60, "TLS certificate verification failed (curl exit code 60)"],
    ] as const) {
      const curlDir = await mkdtemp(join(tmpdir(), `coforge-curl-${code}-`));
      temporaryDirectories.push(curlDir);
      await writeExecutable(join(curlDir, "curl"), `#!/bin/sh\nexit ${code}\n`);
      const env = {
        ...process.env,
        PATH: `${curlDir}:${process.env.PATH ?? ""}`,
        COFORGE_RELEASE_FEED_URL: "https://releases.example.test",
      };

      const bootstrap = await run(["--version", "latest", "--target", "linux-x64"], env);
      expect(bootstrap.exitCode).toBe(1);
      expect(bootstrap.stderr).toContain(expectedSnippet);
      expect(bootstrap.stderr).toMatch(/firewall|proxy/i);

      const resolveOnly = await run(
        ["--resolve-only", "--version", "latest", "--target", "linux-x64"],
        env,
      );
      expect(resolveOnly.exitCode).toBe(75);
      expect(resolveOnly.stderr).toContain(expectedSnippet);
    }
  },
);

test("install.ps1 avoids RuntimeInformation.OSArchitecture so Windows PowerShell 5.1 with PSReadLine does not dereference null", async () => {
  const powershell = await readFile(powershellScript, "utf8");
  const powershellCode = powershell
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  expect(powershellCode).not.toContain("RuntimeInformation");
  expect(powershellCode).not.toContain("OSArchitecture");
  expect(powershellCode).toContain("PROCESSOR_ARCHITEW6432");
  expect(powershellCode).toContain("PROCESSOR_ARCHITECTURE");
});

test("install.ps1 resolves Windows x64 and arm64 across WOW64 and native environment variables and rejects unsupported architectures", async () => {
  const requested: string[] = [];
  const server = serveStub({
    fetch(request) {
      requested.push(new URL(request.url).pathname);
      return new Response("3.2.1\n");
    },
  });
  const feedUrl = `http://127.0.0.1:${server.port}`;

  const cases: Array<{
    name: string;
    env: Record<string, string | undefined>;
    expectedPlatform: string;
  }> = [
    {
      name: "WOW64 32-bit process on ARM64 Windows",
      env: { PROCESSOR_ARCHITEW6432: "ARM64", PROCESSOR_ARCHITECTURE: "x86" },
      expectedPlatform: "Detected platform: Windows ARM64",
    },
    {
      name: "WOW64 32-bit process on x64 Windows",
      env: { PROCESSOR_ARCHITEW6432: "AMD64", PROCESSOR_ARCHITECTURE: "x86" },
      expectedPlatform: "Detected platform: Windows x64",
    },
    {
      name: "native ARM64 process",
      env: { PROCESSOR_ARCHITECTURE: "ARM64" },
      expectedPlatform: "Detected platform: Windows ARM64",
    },
    {
      name: "native x64 process",
      env: { PROCESSOR_ARCHITECTURE: "AMD64" },
      expectedPlatform: "Detected platform: Windows x64",
    },
  ];

  for (const entry of cases) {
    const child = await runPowerShellWithEnv(
      ["-ResolveOnly", "-Version", "3.2.1"],
      feedUrl,
      entry.env,
    );
    expect(child.exitCode, entry.name).toBe(0);
    expect(child.stdout.trim(), entry.name).toBe("3.2.1");
    expect(child.stderr, entry.name).toContain(entry.expectedPlatform);
  }

  const unsupported = await runPowerShellWithEnv(["-ResolveOnly", "-Version", "3.2.1"], feedUrl, {
    PROCESSOR_ARCHITECTURE: "x86",
  });
  expect(unsupported.exitCode).not.toBe(0);
  expect(unsupported.stderr).toContain("unsupported Windows architecture: x86");
  expect(requested).toEqual([]);
}, 30000);

test("install.ps1 maps curl exit codes 35 and 60 to firewall and TLS-interception hints while preserving exit statuses", async () => {
  if (process.platform === "win32") return;
  for (const [code, expectedSnippet] of [
    [35, "curl exit code 35 (TLS handshake failed"],
    [60, "curl exit code 60 (TLS certificate verification failed"],
  ] as const) {
    const bootstrap = await runPowerShellWithEnv(
      ["-Version", "latest", "-Target", "windows-x64"],
      "https://releases.example.test",
      {},
      code,
    );
    // PowerShell 7 wraps thrown exception messages across `| ` gutter lines at 80 columns.
    const unwrappedBootstrapStderr = bootstrap.stderr.replace(/\s*\n\s*\|\s*/g, " ");
    expect(bootstrap.exitCode).toBe(1);
    expect(unwrappedBootstrapStderr).toContain(expectedSnippet);
    expect(unwrappedBootstrapStderr).toMatch(/firewall|proxy/i);

    const resolveOnly = await runPowerShellWithEnv(
      ["-ResolveOnly", "-Version", "latest", "-Target", "windows-x64"],
      "https://releases.example.test",
      {},
      code,
    );
    expect(resolveOnly.exitCode).toBe(75);
    expect(resolveOnly.stderr).toContain(expectedSnippet);
    expect(resolveOnly.stderr).toMatch(/firewall|proxy/i);
  }
}, 30000);
