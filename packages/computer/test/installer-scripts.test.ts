import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const script = resolve(import.meta.dir, "../../../scripts/release/install.sh");

/** Bun.spawnSync blocks the whole JS thread, including the fixture Bun.serve running in this
 * same process - a synchronous spawn here would deadlock the moment the script tries to reach
 * the fixture server. Bun.spawn keeps the event loop free so the fixture can respond. */
async function run(
  args: string[],
  env: Record<string, string | undefined>,
  isolatedHome?: string,
  shellRoots: { zdotdir?: string; xdgConfigHome?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; home: string }> {
  // Every installer execution gets a disposable HOME. This is a safety boundary, not just test
  // cleanup: behavior tests exercise shell startup-file persistence and must never append to the
  // developer's real shell configuration, even when callers spread process.env.
  const home = isolatedHome ?? (await mkdtemp(join(tmpdir(), "coforge-installer-home-")));
  if (!isolatedHome) temporaryDirectories.push(home);
  const child = Bun.spawn({
    cmd: [script, ...args],
    env: {
      ...env,
      HOME: home,
      ZDOTDIR: shellRoots.zdotdir ?? home,
      XDG_CONFIG_HOME: shellRoots.xdgConfigHome ?? join(home, ".config"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, home };
}

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Mirrors install.sh's own `uname -s`-`uname -m` switch, so the fixture serves the exact
 * target path the script under test will request. */
function currentTarget(): string {
  const system = Bun.spawnSync({ cmd: ["uname", "-s"] })
    .stdout.toString()
    .trim();
  const machine = Bun.spawnSync({ cmd: ["uname", "-m"] })
    .stdout.toString()
    .trim();
  const targets: Record<string, string> = {
    "Linux-x86_64": "linux-x64",
    "Linux-aarch64": "linux-arm64",
    "Linux-arm64": "linux-arm64",
    "Darwin-x86_64": "darwin-x64",
    "Darwin-arm64": "darwin-arm64",
  };
  const target = targets[`${system}-${machine}`];
  if (!target) throw new Error(`unsupported test platform: ${system}-${machine}`);
  return target;
}

/** The objects the bootstrap path requests, in order, for the fixture's installer version 0.1.0. */
function bootstrapRequests(target: string): string[] {
  return [
    "/installer/latest",
    `/installer/0.1.0/${target}/coforge-installer.gz`,
    `/installer/0.1.0/${target}/coforge-installer.sha256`,
  ];
}

/** The fake `coforge-installer`: it records its arguments, then (like the real installer) leaves an
 * executable shim where packages/computer/src/paths.ts resolves it. It refuses any invocation other
 * than `install --version <v>`, so a bootstrap that passes the wrong arguments fails loudly. */
function fakeInstaller(
  log: string,
  options: {
    omitShim?: boolean;
    installerExitStatus?: number;
    shimArgumentLog?: string;
    shimExitStatus?: number;
  },
) {
  const shim =
    (options.shimArgumentLog ? `printf '%s\\n' "$@" > '${options.shimArgumentLog}'\n` : "") +
    `exit ${options.shimExitStatus ?? 0}\n`;
  return Buffer.from(
    `#!/bin/sh\n` +
      `[ "$#" -eq 3 ] && [ "$1" = install ] && [ "$2" = --version ] || exit 90\n` +
      `printf '%s\\n' "$@" > "${log}"\n` +
      (options.installerExitStatus ? `exit ${options.installerExitStatus}\n` : "") +
      (options.omitShim
        ? ""
        : `bin_directory=\${XDG_BIN_HOME:-}\n` +
          `case "$bin_directory" in\n  /*) ;;\n  *) bin_directory="$HOME/.local/bin" ;;\nesac\n` +
          `mkdir -p "$bin_directory"\n` +
          `cat > "$bin_directory/coforge-computer" <<'SHIM'\n#!/bin/sh\n${shim}SHIM\n` +
          `chmod 755 "$bin_directory/coforge-computer"\n`),
  );
}

/** Serves the Computer objects the --prepare-directory and --resolve-only calls read, and the installer
 * feed the default bootstrap reads: `installer/latest`, one installer gzip for the target and its sidecar. */
async function serveFixture(
  options: {
    version?: string;
    installerVersion?: string;
    target?: string;
    argumentLog?: string;
    objects?: Record<string, Uint8Array>;
    corruptGzip?: boolean;
    installerLatestContent?: string;
    omitInstaller?: boolean;
    installerGzipStatus?: number;
    corruptInstallerGzip?: boolean;
    omitInstallerSidecar?: boolean;
    tamperInstallerChecksum?: boolean;
    installerExitStatus?: number;
    omitShim?: boolean;
    shimArgumentLog?: string;
    shimExitStatus?: number;
    redirectPaths?: string[];
  } = {},
) {
  const version = options.version ?? "3.2.1";
  const installerVersion = options.installerVersion ?? "0.1.0";
  const target = options.target ?? currentTarget();
  const log = options.argumentLog ?? "/dev/null";
  const installer = fakeInstaller(log, options);
  const installerGzipName = target.startsWith("windows-")
    ? "coforge-installer.exe.gz"
    : "coforge-installer.gz";
  const installerRoot = `/installer/${installerVersion}/${target}`;
  const installerChecksum = options.tamperInstallerChecksum ? "0".repeat(64) : sha256hex(installer);

  const files = new Map<string, Uint8Array>([
    ["/latest", Buffer.from(`${version}\n`)],
    [`/${version}/manifest.json`, Buffer.from('{"schema_version":2}')],
    [
      `/${version}/${target}/coforge-computer.gz`,
      options.corruptGzip ? Buffer.from("not gzip") : Bun.gzipSync(Buffer.from("computer bytes")),
    ],
    [`/${version}/photon_rs_bg.wasm`, Buffer.from("#wasm-fixture\n")],
    ["/installer/latest", Buffer.from(options.installerLatestContent ?? `${installerVersion}\n`)],
  ]);
  if (!options.omitInstaller) {
    files.set(
      `${installerRoot}/${installerGzipName}`,
      options.corruptInstallerGzip ? Buffer.from("not gzip") : Bun.gzipSync(installer),
    );
  }
  if (!options.omitInstallerSidecar) {
    files.set(`${installerRoot}/coforge-installer.sha256`, Buffer.from(`${installerChecksum}\n`));
  }
  for (const [path, bytes] of Object.entries(options.objects ?? {})) files.set(path, bytes);

  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (options.redirectPaths?.includes(path)) {
        return new Response("moved", { status: 302, headers: { Location: "/elsewhere" } });
      }
      if (path === `${installerRoot}/${installerGzipName}` && options.installerGzipStatus) {
        return new Response("failure", { status: options.installerGzipStatus });
      }
      const bytes = files.get(path);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://localhost:${server.port}`, version, target, requested };
}

test("install.sh prepares cross-target gzip once without executing or configuring PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "executed");
  const fixture = await serveFixture({
    target: "windows-arm64",
    argumentLog: log,
  });
  const child = await run(["--prepare-directory", directory, "--target", fixture.target], {
    ...process.env,
    SHELL: "/bin/bash",
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).toBe(0);
  expect(fixture.requested).toEqual([
    "/latest",
    `/${fixture.version}/manifest.json`,
    `/${fixture.version}/${fixture.target}/coforge-computer.gz`,
    `/${fixture.version}/photon_rs_bg.wasm`,
  ]);
  expect((await readdir(directory)).sort()).toEqual([
    "coforge-computer.gz",
    "manifest.json",
    "photon_rs_bg.wasm",
    "version",
  ]);
  expect(await Bun.file(join(directory, "version")).text()).toBe("3.2.1\n");
  expect(await readdir(child.home)).toEqual([]);
  expect(child.stderr.indexOf("Windows ARM64")).toBeLessThan(
    child.stderr.indexOf("Finding the latest"),
  );
  expect(child.stderr).toContain("Resolved version: 3.2.1");
});

test("install.sh resolve-only prints only the concrete version and fetches no package", async () => {
  for (const selector of ["latest", "3.2.1"]) {
    const fixture = await serveFixture();
    const child = await run(["--resolve-only", "--version", selector, "--target", "darwin-arm64"], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout).toBe("3.2.1\n");
    expect(child.stderr).toContain("Detected platform: macOS (Apple Silicon)");
    expect(child.stderr).toContain("Resolved version: 3.2.1");
    expect(fixture.requested).toEqual(selector === "latest" ? ["/latest"] : []);
    expect(await readdir(child.home)).toEqual([]);
  }
});

test("install.sh bootstrap fetches only the installer pointer, gzip and sidecar, then runs the installer with the requested version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");

  for (const selector of ["latest", "3.2.1"] as const) {
    const fixture = await serveFixture({ argumentLog: log });
    const child = await run(["--version", selector], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "install",
      "--version",
      selector,
    ]);
    // The installer resolves the Computer version itself, so no Computer object is requested.
    expect(fixture.requested).toEqual(bootstrapRequests(fixture.target));
    expect(child.stderr).toContain("==> Downloading CoForge installer");
    expect(child.stderr).not.toContain("Downloading CoForge Computer");
  }

  const omitted = await serveFixture({ argumentLog: log });
  const defaulted = await run([], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: omitted.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(defaulted.exitCode).toBe(0);
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    "install",
    "--version",
    "latest",
  ]);
});

test("install.sh bootstrap propagates the installer's exit status and reports no success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
  temporaryDirectories.push(directory);
  const fixture = await serveFixture({
    argumentLog: join(directory, "arguments"),
    installerExitStatus: 7,
  });
  const child = await run(["--version", fixture.version], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).toBe(7);
  expect(child.stderr).not.toContain(`CoForge Computer ${fixture.version} installed`);
  expect(child.stderr).not.toContain("no shim appeared");
});

test("install.sh bootstrap refuses an installer that fails its sidecar checksum before running it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const fixture = await serveFixture({ argumentLog: log, tamperInstallerChecksum: true });
  const child = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("failed its checksum check");
  expect(await Bun.file(log).exists()).toBe(false);
});

for (const [options, expected] of [
  [{ omitInstaller: true }, "returned error: 404"],
  [{ installerGzipStatus: 500 }, "returned error: 500"],
  [{ corruptInstallerGzip: true }, "could not be decompressed safely"],
  [{ omitInstallerSidecar: true }, "returned error: 404"],
] as const) {
  test(`install.sh bootstrap fails closed without running an installer for ${JSON.stringify(options)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const fixture = await serveFixture({ ...options, argumentLog: log });
    const child = await run(["--version", fixture.version], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain(expected);
    expect(fixture.requested.some((path) => path.includes("/coforge-computer"))).toBe(false);
    expect(await Bun.file(log).exists()).toBe(false);
  });
}

test("install.sh bootstrap refuses redirects for the installer pointer and its sidecar", async () => {
  const sidecar = `/installer/0.1.0/${currentTarget()}/coforge-installer.sha256`;
  for (const redirected of ["/installer/latest", sidecar]) {
    const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const fixture = await serveFixture({ argumentLog: log, redirectPaths: [redirected] });
    const child = await run(["--version", "latest"], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain("HTTP 302");
    expect(fixture.requested).not.toContain("/elsewhere");
    expect(await Bun.file(log).exists()).toBe(false);
  }
});

test("install.sh quiet-header preparation only reports downloading and leaves verification to the updater", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const fixture = await serveFixture({ corruptGzip: true });
  const child = await run(
    ["--prepare-directory", directory, "--version", fixture.version, "--quiet-header"],
    {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
  );
  expect(child.exitCode).toBe(0);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("==> Downloading CoForge Computer\n");
  expect(await Bun.file(join(directory, "coforge-computer.gz")).text()).toBe("not gzip");
});

test("install.sh's installer phase downloads only the target's coforge-installer gzip", async () => {
  for (const [target, object] of [
    ["linux-x64", "coforge-installer.gz"],
    ["darwin-arm64", "coforge-installer.gz"],
    ["windows-arm64", "coforge-installer.exe.gz"],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
    temporaryDirectories.push(directory);
    const requested: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requested.push(path);
        return path === `/installer/0.1.0/${target}/${object}`
          ? new Response("installer bytes")
          : new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const child = await run(
      [
        "--prepare-directory",
        directory,
        "--version",
        "0.1.0",
        "--target",
        target,
        "--prepare-phase",
        "installer",
        "--quiet-header",
      ],
      {
        ...process.env,
        COFORGE_RELEASE_FEED_URL: `http://127.0.0.1:${server.port}/installer`,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
    );
    expect(child.exitCode).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("==> Downloading CoForge installer\n");
    expect(requested).toEqual([`/installer/0.1.0/${target}/${object}`]);
    expect(await readdir(directory)).toEqual([object]);
    expect(await Bun.file(join(directory, object)).text()).toBe("installer bytes");
  }
});

test("install.sh's installer phase needs a preparation directory and refuses redirects", async () => {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requested.push(new URL(request.url).pathname);
      return new Response("installer bytes", { status: 302, headers: { Location: "/elsewhere" } });
    },
  });
  servers.push(server);
  const environment = {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: `http://127.0.0.1:${server.port}/installer`,
    COFORGE_INSTALLER_TEST_MODE: "1",
  };
  const withoutDirectory = await run(
    ["--version", "0.1.0", "--target", "linux-x64", "--prepare-phase", "installer"],
    environment,
  );
  expect(withoutDirectory.exitCode).toBe(2);
  expect(requested).toEqual([]);

  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const redirected = await run(
    [
      "--prepare-directory",
      directory,
      "--version",
      "0.1.0",
      "--target",
      "linux-x64",
      "--prepare-phase",
      "installer",
    ],
    environment,
  );
  expect(redirected.exitCode).not.toBe(0);
  expect(redirected.stderr).toContain("HTTP 302");
  // Only the one object was asked for; the redirect target never was.
  expect(requested).toEqual(["/installer/0.1.0/linux-x64/coforge-installer.gz"]);
});

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
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requested.push(path);
        return path === `/installer/0.1.0/${target}/${object}`
          ? new Response("installer bytes")
          : new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

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
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requested.push(new URL(request.url).pathname);
      return new Response("installer bytes", {
        status: 302,
        headers: { Location: "/elsewhere" },
      });
    },
  });
  servers.push(server);
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

test("install.sh refuses unknown targets and nonexistent preparation directories before fetching", async () => {
  const fixture = await serveFixture();
  for (const args of [
    ["--resolve-only", "--target", "../linux-x64"],
    ["--prepare-directory", "/does-not-exist/coforge"],
  ]) {
    const child = await run(args, {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).not.toBe(0);
  }
  expect(fixture.requested).toEqual([]);
});

for (const object of ["latest", "manifest.json", "coforge-computer.gz", "photon_rs_bg.wasm"]) {
  test(`install.sh preparation refuses ${object} redirects, even with a usable response body`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
    temporaryDirectories.push(directory);
    const requested: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requested.push(path);
        return new Response(
          path === "/latest" ? "3.2.1" : "{}",
          path.endsWith(`/${object}`) ? { status: 302, headers: { Location: "/redirected" } } : {},
        );
      },
    });
    servers.push(server);
    const child = await run(["--prepare-directory", directory], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: `http://localhost:${server.port}`,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain("HTTP 302");
    expect(requested).not.toContain("/redirected");
    expect(await Bun.file(join(directory, "version")).exists()).toBe(false);
  });
}

test("install.sh bounds manifest downloads at 1 MiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(Buffer.alloc(1048577, 0x20));
    },
  });
  servers.push(server);
  const child = await run(["--prepare-directory", directory, "--version", "3.2.1"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: `http://localhost:${server.port}`,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("curl: (63)");
  expect(await Bun.file(join(directory, "coforge-computer.gz")).exists()).toBe(false);
});

test("install.sh bounds photon_rs_bg.wasm downloads at 16 MiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const version = "3.2.1";
  const target = currentTarget();
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
  const files = new Map<string, Uint8Array>([
    [`/${version}/manifest.json`, Buffer.from("{}")],
    [`/${version}/${target}/coforge-computer.gz`, Bun.gzipSync(Buffer.from("test"))],
    [`/${version}/photon_rs_bg.wasm`, oversized],
  ]);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const bytes = files.get(new URL(request.url).pathname);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const child = await run(["--prepare-directory", directory, "--version", version], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: `http://localhost:${server.port}`,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("curl: (63)");
  expect(await Bun.file(join(directory, "photon_rs_bg.wasm")).exists()).toBe(false);
});

test("install.sh downloads photon_rs_bg.wasm silently, under the existing Downloading CoForge Computer step, with no new progress line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
  temporaryDirectories.push(directory);
  const fixture = await serveFixture();
  const child = await run(["--prepare-directory", directory, "--version", fixture.version], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).toBe(0);
  expect(fixture.requested).toContain(`/${fixture.version}/photon_rs_bg.wasm`);
  expect(await Bun.file(join(directory, "photon_rs_bg.wasm")).exists()).toBe(true);
  // The image library downloads inside the existing Computer step, with no progress line of its own.
  const steps = child.stderr.split("\n").filter((line) => line.startsWith("==>"));
  expect(steps).toEqual([
    expect.stringContaining("Detected platform:"),
    `==> Resolved version: ${fixture.version}`,
    "==> Downloading CoForge Computer",
  ]);
});

test("install.sh rejects an unparsable version before making any request", async () => {
  const child = await run(["--version", "../etc/passwd"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: "http://localhost:1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("version must be");
});

test("install.sh rejects '.' and a version starting with '-' before making any request", async () => {
  for (const invalid of [".", "-rf"]) {
    const child = await run(["--version", invalid], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: "http://localhost:1",
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain("version must be");
  }
});

test("install.sh refuses a plain-HTTP feed outside test mode", async () => {
  const child = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: "http://localhost:1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("HTTPS");
});

test("install.sh clearly reports when gzip is unavailable", async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), "coforge-empty-path-"));
  temporaryDirectories.push(emptyPath);
  const child = await run(["--version", "3.2.1"], {
    PATH: emptyPath,
    COFORGE_RELEASE_FEED_URL: "https://releases.example.test",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("gzip is required");
});

const invalidInstallerPointers: Array<[name: string, content: string]> = [
  ["an HTML error page", "<html><body>502 Bad Gateway</body></html>"],
  ["content containing a traversal segment", ".."],
  ["an empty body", ""],
  ["the unresolved latest selector", "latest"],
];

for (const [name, installerLatestContent] of invalidInstallerPointers) {
  test(`install.sh fails closed and never fetches the installer when the installer pointer returns ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const fixture = await serveFixture({ installerLatestContent, argumentLog: log });

    const child = await run(["--version", "latest"], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });

    expect(child.exitCode).not.toBe(0);
    // Pin the exact message: a stubbed-out is_valid_version() would still fail these bodies, but
    // with an unrelated download error, so the check under test would be unverified.
    expect(child.stderr).toContain(
      "install.sh: the installer pointer did not return a valid version",
    );
    expect(fixture.requested).toEqual(["/installer/latest"]);
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });
}

test("install.sh bootstrap caps the size of the installer pointer and sidecar downloads", async () => {
  // Both objects are tiny, feed-controlled text with no advertised size of their own, so a response
  // well past the 4096-byte cap must be rejected before the script trusts it. Pin curl's own "(63)"
  // exit signal: without the cap a 5000-byte body still fails the version or length check, and a
  // nonzero exit alone would pass for the wrong reason.
  const oversized = Buffer.alloc(5000, 0x61);
  const pointer = await serveFixture({ objects: { "/installer/latest": oversized } });
  const pointerChild = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: pointer.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(pointerChild.exitCode).not.toBe(0);
  expect(pointerChild.stderr).toContain("curl: (63)");

  const sidecar = await serveFixture({
    objects: { [`/installer/0.1.0/${currentTarget()}/coforge-installer.sha256`]: oversized },
  });
  const sidecarChild = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: sidecar.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(sidecarChild.exitCode).not.toBe(0);
  expect(sidecarChild.stderr).toContain("curl: (63)");
});

test("install.sh removes its temporary directory after a successful install instead of exec-leaking it", async () => {
  // Regression test for N1: `exec`-ing the computer binary replaces this shell process, so the
  // `trap ... EXIT` cleanup never runs and the ~138 MB binary is left behind in $TMPDIR on every
  // install. Point $TMPDIR at an empty, dedicated directory and assert it is empty again once
  // the script (which runs the binary as an ordinary child, not via exec) exits successfully.
  const testTmpDir = await mkdtemp(join(tmpdir(), "coforge-tmpdir-"));
  temporaryDirectories.push(testTmpDir);
  const fixture = await serveFixture();

  const child = await run(["--version", "latest"], {
    ...process.env,
    TMPDIR: testTmpDir,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });

  expect(child.exitCode).toBe(0);
  expect(await readdir(testTmpDir)).toEqual([]);
});

test("installer test helper never uses inherited shell configuration roots", async () => {
  const fixture = await serveFixture();
  const external = await mkdtemp(join(tmpdir(), "coforge-external-shell-"));
  temporaryDirectories.push(external);
  await mkdir(join(external, "fish/conf.d"), { recursive: true });
  for (const path of [join(external, ".zshrc"), join(external, "fish/conf.d/coforge.fish")]) {
    await Bun.write(path, "# sentinel\n");
  }
  for (const shell of ["zsh", "fish"]) {
    const result = await run(["--version", fixture.version], {
      ...process.env,
      SHELL: `/usr/bin/${shell}`,
      ZDOTDIR: external,
      XDG_CONFIG_HOME: external,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(result.exitCode).toBe(0);
  }
  expect(await Bun.file(join(external, ".zshrc")).text()).toBe("# sentinel\n");
  expect(await Bun.file(join(external, "fish/conf.d/coforge.fish")).text()).toBe("# sentinel\n");
});

for (const shell of ["bash", "zsh", "fish"] as const) {
  test(`install.sh preserves and idempotently updates ${shell} PATH configuration`, async () => {
    const fixture = await serveFixture();
    const xdg = await mkdtemp(join(tmpdir(), "coforge-xdg-"));
    const zdot = await mkdtemp(join(tmpdir(), "coforge-zdot-"));
    temporaryDirectories.push(xdg, zdot);
    const first = await run(
      ["--version", fixture.version],
      {
        ...process.env,
        SHELL: `/usr/bin/${shell}`,
        XDG_CONFIG_HOME: xdg,
        ZDOTDIR: zdot,
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
      undefined,
      { zdotdir: zdot, xdgConfigHome: xdg },
    );
    expect(first.exitCode).toBe(0);

    const configuration =
      shell === "fish"
        ? join(xdg, "fish/conf.d/coforge.fish")
        : shell === "zsh"
          ? join(zdot, ".zshrc")
          : join(first.home, ".bashrc");
    const original = "# existing user configuration";
    // Put existing content before a repeated install to prove it is preserved rather than
    // replacing the startup file. The first install's PATH line must remain singular too.
    const firstContent = await readFile(configuration, "utf8");
    await Bun.write(configuration, `${original}\n${firstContent}`);

    const second = await run(
      ["--version", fixture.version],
      {
        ...process.env,
        SHELL: `/usr/bin/${shell}`,
        XDG_CONFIG_HOME: xdg,
        ZDOTDIR: zdot,
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
      first.home,
      { zdotdir: zdot, xdgConfigHome: xdg },
    );
    const secondConfiguration = configuration;
    expect(second.exitCode).toBe(0);
    const content = await readFile(secondConfiguration, "utf8");
    const pathLine =
      shell === "fish"
        ? 'fish_add_path "$HOME/.local/bin"'
        : 'export PATH="$HOME/.local/bin:$PATH"';
    expect(content).toContain(original);
    expect(content.split(pathLine)).toHaveLength(2);
    expect(first.stderr).toContain("Current terminal:");
    // Setup owns automatic sign-in; keep one actionable, absolute command.
    expect(first.stderr).toContain(
      `"${join(first.home, ".local/bin/coforge-computer")}" setup --workspace <slug>`,
    );
    if (shell === "bash") {
      const loginProfile = await readFile(join(first.home, ".bash_profile"), "utf8");
      expect(loginProfile.split(pathLine)).toHaveLength(2);
    }

    const shellExecutable = Bun.which(shell);
    if (shellExecutable) {
      const installedBin = join(first.home, ".local/bin");
      await mkdir(installedBin, { recursive: true });
      const installedExecutable = join(installedBin, "coforge-computer");
      await Bun.write(installedExecutable, "#!/bin/sh\nexit 0\n");
      await Bun.spawn({ cmd: ["chmod", "700", installedExecutable] }).exited;
      const shellArgs =
        shell === "bash"
          ? ["--noprofile", "--rcfile", configuration, "-i", "-c", "command -v coforge-computer"]
          : ["-i", "-c", "command -v coforge-computer"];
      const freshShell = Bun.spawn({
        cmd: [shellExecutable, ...shellArgs],
        env: {
          ...process.env,
          HOME: first.home,
          ZDOTDIR: zdot,
          XDG_CONFIG_HOME: xdg,
        },
        stdout: "pipe",
        stderr: "ignore",
      });
      const [exitCode, stdout] = await Promise.all([
        freshShell.exited,
        new Response(freshShell.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(installedExecutable);
    }
  });
}

// The reason the shim goes to the XDG user binary directory at all: for most users it is already
// on PATH, and then a fresh install is usable in the shell that ran the installer. Nothing may be
// appended to shell configuration in that case, and the installer must not print the PATH advice
// - a user told to run `fish_add_path` for a directory already on PATH is being sent to fix a
// problem they do not have.
for (const shell of ["bash", "zsh", "fish"] as const) {
  test(`install.sh changes no ${shell} configuration when the shim directory is already on PATH`, async () => {
    const fixture = await serveFixture();
    const home = await mkdtemp(join(tmpdir(), "coforge-installer-home-"));
    const xdg = await mkdtemp(join(tmpdir(), "coforge-xdg-"));
    const zdot = await mkdtemp(join(tmpdir(), "coforge-zdot-"));
    temporaryDirectories.push(home, xdg, zdot);

    const result = await run(
      ["--version", fixture.version],
      {
        ...process.env,
        PATH: `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`,
        SHELL: `/usr/bin/${shell}`,
        XDG_CONFIG_HOME: xdg,
        ZDOTDIR: zdot,
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
      home,
      { zdotdir: zdot, xdgConfigHome: xdg },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`CoForge Computer ${fixture.version} installed`);
    expect(result.stderr).not.toContain("coforge-computer login");
    expect(result.stderr).toContain("coforge-computer setup --workspace <slug>");
    // The bare command the installer just told the user to run has to resolve on the PATH the
    // installer itself saw - that is the whole claim being made here.
    expect(await Bun.file(join(home, ".local/bin/coforge-computer")).exists()).toBe(true);
    expect(result.stderr).not.toContain("Current terminal:");
    expect(result.stderr).not.toContain("fish_add_path");
    expect(result.stderr).not.toContain("export PATH=");
    for (const configuration of [
      join(xdg, "fish/conf.d/coforge.fish"),
      join(zdot, ".zshrc"),
      join(home, ".bashrc"),
      join(home, ".bash_profile"),
      join(home, ".profile"),
    ]) {
      expect(await Bun.file(configuration).exists()).toBe(false);
    }
  });
}

// install.sh is served by the web app while binaries come from the release feed, so a user can
// reach a version published before the shim moved. The script must not report success or print
// advice naming a command that was never installed.
test("install.sh fails when the installed version leaves no shim where it expects one", async () => {
  const fixture = await serveFixture({ omitShim: true });
  const result = await run(["--version", fixture.version], {
    ...process.env,
    SHELL: "/usr/bin/zsh",
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("no shim appeared at");
  expect(result.stderr).toContain("predates this installer");
  expect(result.stderr).not.toContain(`CoForge Computer ${fixture.version} installed`);
  expect(await Bun.file(join(result.home, ".zshrc")).exists()).toBe(false);
});

// XDG_BIN_HOME relocates the shim, and the installer must resolve it exactly as
// packages/computer/src/paths.ts does - otherwise it writes PATH setup for, or advertises, a
// directory the binary never installs into.
test("install.sh follows an absolute XDG_BIN_HOME and ignores a relative one", async () => {
  const fixture = await serveFixture();
  const binHome = await mkdtemp(join(tmpdir(), "coforge-bin-home-"));
  temporaryDirectories.push(binHome);

  const relocated = await run(["--version", fixture.version], {
    ...process.env,
    PATH: `${binHome}:${process.env.PATH ?? ""}`,
    SHELL: "/usr/bin/zsh",
    XDG_BIN_HOME: binHome,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(relocated.exitCode).toBe(0);
  expect(relocated.stderr).not.toContain("To use it in this one, run:");

  const relative = await run(["--version", fixture.version], {
    ...process.env,
    SHELL: "/usr/bin/zsh",
    XDG_BIN_HOME: "bin",
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(relative.exitCode).toBe(0);
  expect(await readFile(join(relative.home, ".zshrc"), "utf8")).toContain(
    'export PATH="$HOME/.local/bin:$PATH"',
  );
});

// The web's connect dialog is one pasted command. The installer's PATH edit only reaches shells
// started later, so `--workspace` has to run setup through the shim's own path - when the
// directory is already on PATH, when this run just added it, and when XDG_BIN_HOME relocates it -
// and the script ends with setup's own status.
for (const variant of [
  { name: "its directory is on PATH", onPath: true },
  { name: "its directory is not on PATH and setup fails", setupStatus: 7 },
  { name: "XDG_BIN_HOME relocates it", relocated: true },
]) {
  test(`install.sh --workspace runs setup with the installed shim when ${variant.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-shim-log-"));
    const home = await mkdtemp(join(tmpdir(), "coforge-installer-home-"));
    temporaryDirectories.push(directory, home);
    const shimLog = join(directory, "arguments");
    const fixture = await serveFixture({
      shimArgumentLog: shimLog,
      shimExitStatus: variant.setupStatus,
    });

    const result = await run(
      ["--version", fixture.version, "--workspace", "acme-inc"],
      {
        ...process.env,
        PATH: variant.onPath
          ? `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`
          : process.env.PATH,
        SHELL: "/usr/bin/zsh",
        XDG_BIN_HOME: variant.relocated ? join(directory, "bin") : undefined,
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
      home,
    );

    expect(result.exitCode).toBe(variant.setupStatus ?? 0);
    expect(await readFile(shimLog, "utf8")).toBe("setup\n--workspace\nacme-inc\n");
    expect(result.stderr).not.toContain("Next:");
  });
}

test("install.sh refuses --workspace without a value before fetching", async () => {
  const fixture = await serveFixture();
  const result = await run(["--workspace"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(result.exitCode).toBe(2);
  expect(fixture.requested).toEqual([]);
});

test("install.sh reports PATH persistence failure and does not claim install success", async () => {
  const fixture = await serveFixture();
  const notDirectory = join(await mkdtemp(join(tmpdir(), "coforge-zdot-file-")), "file");
  temporaryDirectories.push(notDirectory.slice(0, -5));
  await Bun.write(notDirectory, "not a directory");
  const child = await run(
    ["--version", fixture.version],
    {
      ...process.env,
      SHELL: "/usr/bin/zsh",
      ZDOTDIR: notDirectory,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
    undefined,
    { zdotdir: notDirectory },
  );
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("PATH could not be saved");
  expect(child.stderr).not.toContain(`CoForge Computer ${fixture.version} installed`);
});

test("install.sh shows curl progress only for the binary download on a terminal", async () => {
  const fixture = await serveFixture();
  const directory = await mkdtemp(join(tmpdir(), "coforge-curl-wrapper-"));
  temporaryDirectories.push(directory);
  const curlLog = join(directory, "curl.log");
  const realCurl = Bun.which("curl");
  if (!realCurl) throw new Error("curl is required for installer tests");
  await Bun.write(
    join(directory, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_ARGUMENT_LOG"\nexec "${realCurl}" "$@"\n`,
  );
  await Bun.spawn({ cmd: ["chmod", "700", join(directory, "curl")] }).exited;
  const home = await mkdtemp(join(tmpdir(), "coforge-installer-home-"));
  temporaryDirectories.push(home);
  const child = Bun.spawn({
    cmd:
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", script, "--version", "latest"]
        : ["script", "-q", "-e", "-c", `${script} --version latest`, "/dev/null"],
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/usr/bin/bash",
      PATH: `${directory}:${process.env.PATH}`,
      CURL_ARGUMENT_LOG: curlLog,
      NO_COLOR: "1",
      COFORGE_INSTALLER_NO_COLOR: "1",
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  const calls = (await readFile(curlLog, "utf8")).trim().split("\n");
  const latest = calls.find((call) => call.endsWith("/installer/latest"));
  const sidecar = calls.find((call) => call.includes("coforge-installer.sha256"));
  const binary = calls.find((call) => call.includes("coforge-installer.gz"));
  expect(latest).toContain("--silent");
  expect(sidecar).toContain("--silent");
  expect(latest).not.toContain("--progress-bar");
  expect(sidecar).not.toContain("--progress-bar");
  expect(binary).toContain("--progress-bar");
  expect(binary).not.toContain("--silent");
});

test("install.sh renders native curl progress before a gated response completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-progress-"));
  temporaryDirectories.push(directory);
  const releaseBody = Promise.withResolvers<void>();
  let bodyCompleted = false;
  let cancelled = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("manifest.json")) return new Response("{}");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(32768));
            void releaseBody.promise.then(() => {
              if (cancelled) return;
              controller.enqueue(new Uint8Array(32768));
              bodyCompleted = true;
              controller.close();
            });
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Length": "65536" } },
      );
    },
  });
  servers.push(server);
  const args = ["--prepare-directory", directory, "--version", "3.2.1", "--quiet-header"];
  const child = Bun.spawn({
    cmd:
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", script, ...args]
        : [
            "script",
            "-q",
            "-e",
            "-c",
            [script, ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" "),
            "/dev/null",
          ],
    env: {
      ...process.env,
      HOME: directory,
      NO_COLOR: "1",
      COFORGE_INSTALLER_NO_COLOR: "1",
      COFORGE_RELEASE_FEED_URL: `http://localhost:${server.port}`,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(5000),
  });
  let output = "";
  let observedMidDownload = false;
  try {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      // Bun streams this response chunked, so curl uses its indeterminate native bar.
      if (!observedMidDownload && /[#=O -]{5,}\r/.test(output)) {
        expect(bodyCompleted).toBe(false);
        observedMidDownload = true;
        releaseBody.resolve();
      }
    }
    expect(await child.exited).toBe(0);
    expect(observedMidDownload).toBe(true);
    expect(bodyCompleted).toBe(true);
    expect(await Bun.file(join(directory, "coforge-computer.gz")).size).toBe(65536);
  } finally {
    releaseBody.resolve();
  }
}, 10000);

test("install scripts fail closed and stay within the current user's own account", async () => {
  const shell = await readFile(
    resolve(import.meta.dir, "../../../scripts/release/install.sh"),
    "utf8",
  );
  const powershell = await readFile(
    resolve(import.meta.dir, "../../../scripts/release/install.ps1"),
    "utf8",
  );
  // Assertions that an API or scope is *absent* have to read the code alone. Both scripts explain
  // at length which APIs they deliberately avoid, and naming one in a comment is not using it -
  // a scan of the whole file turns those explanations into failures and pushes the next author
  // into deleting the reasoning to make the test pass.
  const powershellCode = powershell
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  expect(shell).not.toContain("sudo");
  expect(shell).not.toContain("/usr/local");
  expect(powershell).not.toContain("Program Files");
  expect(powershell).not.toContain("Start-Process -Verb RunAs");
  // install.ps1 puts the shim directory on PATH, and every part of how it does that is a
  // correctness constraint this repository has no Windows runner to catch at runtime.
  //
  // The current user's environment only: the "Machine" scope and HKLM both need elevation and
  // would change PATH for every account on the machine.
  expect(powershellCode).toContain("Microsoft.Win32.Registry]::CurrentUser");
  expect(powershellCode).not.toContain("HKLM");
  expect(powershellCode).not.toContain('"Machine"');
  // [Environment]::SetEnvironmentVariable(..., "User") reads Path back already expanded and
  // rewrites it as a plain REG_SZ, destroying any %USERPROFILE%-style reference a user has in
  // theirs. The raw registry API with these two options is what preserves it.
  expect(powershellCode).not.toContain("SetEnvironmentVariable(");
  expect(powershellCode).toContain("DoNotExpandEnvironmentNames");
  expect(powershellCode).toContain("RegistryValueKind]::ExpandString");
  // The registry write only reaches future processes; this is what makes the command usable in
  // the session that ran `irm ... | iex`.
  expect(powershellCode).toContain("$env:Path = ");
  // A top-level `exit` terminates the host under `irm ... | iex` - closing the user's window on
  // success as readily as on failure. Errors leave through `throw`, like everything else here.
  expect(powershellCode).not.toMatch(/^\s*exit\b/m);
  expect(powershellCode).toContain("$LASTEXITCODE -ne 0");
  // The Windows shim is a .cmd launcher (packages/computer/src/updater.ts), not an .exe.
  expect(powershellCode).toContain("coforge-computer.cmd");
  // Same home-directory rule as packages/computer/src/cli.ts, and never the read-only $HOME
  // automatic variable, which is not $env:HOME.
  expect(powershellCode).toContain("if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }");
  // Windows PowerShell 5.1 is a supported host, so no PowerShell 6+ only automatic variables.
  expect(powershellCode).not.toContain("$IsWindows");
  // Neither installer pins a checksum for any published object: every payload is verified
  // against the checksum its feed-hosted sidecar (install.sh, install.ps1) or manifest.json
  // (the updater) names at install time.
  expect(shell).not.toMatch(/[0-9a-f]{64}/);
  expect(powershell).not.toMatch(/[0-9a-f]{64}/);
  expect(shell).toContain("HTTPS");
  // curl's progress meter is noisy when stderr is captured by a terminal wrapper. The installer
  // already emits one line per meaningful step and must leave the user with an actionable PATH
  // fix for the user-local shim (a child shell cannot modify its parent's PATH).
  expect(shell).toContain("fetch_binary()");
  expect(shell).toContain("fetch_binary --max-filesize");
  expect(shell).toContain("export PATH=");
  // The shim - the one installed path that must be on PATH - lives in the XDG user binary
  // directory, never in the private ~/.coforge root that nothing has on PATH.
  expect(shell).toContain("$HOME/.local/bin");
  expect(shell).not.toContain(".coforge/computer/bin");
  expect(powershell).toContain("HTTPS");
  // Neither script's size-cap constants may ever be a literal 0: curl treats `--max-filesize 0`
  // as "unlimited" (N4), and install.ps1's Get-CoforgeObject enforces its MaxBytes with a plain
  // `-gt` comparison that a 0 would also defeat (anything read would immediately exceed it, but
  // a cap of 0 has no legitimate meaning here either way - pin both away from it explicitly).
  expect(shell).not.toMatch(/--max-filesize\s+["']?0(?!\d)/);
  expect(shell).toMatch(/^max_pointer_bytes=[1-9]\d*$/m);
  expect(shell).toMatch(/^max_binary_bytes=[1-9]\d*$/m);
  expect(shell).toMatch(/^max_wasm_bytes=[1-9]\d*$/m);
  expect(powershell).toMatch(/^\$maxPointerBytes = [1-9]\d*$/m);
  expect(powershell).toMatch(/^\$maxBinaryBytes = [1-9]\d*$/m);
  expect(powershell).toMatch(/^\$maxWasmBytes = [1-9]\d*$/m);
  // Neither script prints a separate progress step for the wasm object - see the "downloads
  // photon_rs_bg.wasm silently" test above.
  expect(shell).toContain("photon_rs_bg.wasm");
  expect(powershell).toContain("photon_rs_bg.wasm");
  // Shell does not parse JSON; the local installer owns manifest verification.
  expect(shell).not.toContain("jq ");
  expect(shell).toContain("/manifest.json");
  expect(shell).toContain("coforge-computer.gz");
  expect(powershell).toContain("coforge-computer.gz");
  // The `installer` preparation phase names the two installer gzip objects itself, chosen by
  // target; PowerShell has no runner here, so its half is pinned by source.
  expect(shell).toContain("coforge-installer.gz");
  expect(shell).toContain("coforge-installer.exe.gz");
  // The default bootstrap installs through coforge-installer; the hidden Computer entry is not used.
  expect(shell).not.toContain("__install-local");
  expect(powershell).not.toContain("__install-local");
  expect(powershell).toContain('[ValidateSet("all", "manifest", "artifact", "installer")]');
  // Whole expressions, so that swapping the two branches or dropping the target from the URL
  // changes what is pinned: `Windows` picks the .exe.gz, everything else the plain .gz.
  expect(powershell).toContain(
    '$installerGzip = if ($Target.StartsWith("windows-", [System.StringComparison]::Ordinal)) { "coforge-installer.exe.gz" } else { "coforge-installer.gz" }',
  );
  expect(powershell).toContain('-Uri "$feedUrl/$Version/$Target/$installerGzip"');
  expect(powershell).toContain("-OutFile (Join-Path $temporaryDirectory $installerGzip)");
  expect(powershell).toContain("System.IO.Compression.GZipStream");
  expect(powershell).not.toContain('target/coforge-computer"');
});
