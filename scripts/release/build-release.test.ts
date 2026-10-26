import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReleaseManifestSchema } from "@coforge/computer/src/updater";
import { buildReleaseTree, isValidReleaseVersion, type ReleaseInputs } from "./build-release";

// Core acceptance: the feed tree buildReleaseTree() produces must hold, byte-for-byte, what its
// manifest records, and the real scripts/release/install.sh (spawned as a subprocess) must install
// from it. The installer that installs a version is coforge-installer (crates/installer), which
// has its own tests; this file checks the tree it reads. Both are exercised against small fake
// binaries (a shell script, a plain string) rather than a real compile, which is slow and
// intentionally out of scope here - see compile-targets.ts.

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Mirrors install.sh's own `uname -s`-`uname -m` switch (see packages/computer/test/
 * installer-scripts.test.ts), so the host-target fixture below matches the platform the real
 * install.sh spawn will actually detect. */
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

const ALL_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
];

/** Every target gets its own distinct computer bytes. Identical bytes across targets would let a
 * "wrote target A's checksum into target B's
 * sidecar" bug pass the consistency test further down - only distinct bytes make that a real
 * check. `argumentLog` is where a computer "binary" records the arguments it was invoked with;
 * tests that never execute a binary can pass "/dev/null". */
function fixtureArtifacts(argumentLog: string): Record<string, { computer: Uint8Array }> {
  const artifacts: Record<string, { computer: Uint8Array }> = {};
  for (const target of ALL_TARGETS) {
    artifacts[target] = {
      computer: Buffer.from(
        `#!/bin/sh\n# release target: ${target}\nprintf '%s\\n' "$@" > "${argumentLog}"\n`,
      ),
    };
  }
  return artifacts;
}

/** A small, distinct fixture standing in for the real ~1.8 MB `photon_rs_bg.wasm` -
 * scripts/release/photon-wasm.ts and publish.test.ts cover resolving/uploading the real file. */
function fixturePhotonWasm(): Uint8Array {
  return Buffer.from("#wasm-fixture: photon_rs_bg.wasm stand-in\n");
}

function releaseInputs(overrides: Partial<ReleaseInputs> = {}): ReleaseInputs {
  return {
    version: overrides.version ?? "3.2.1",
    commit: overrides.commit ?? "a".repeat(40),
    buildDate: overrides.buildDate ?? "2026-09-04T12:00:00Z",
    artifacts: overrides.artifacts ?? fixtureArtifacts("/dev/null"),
    photonWasm: overrides.photonWasm ?? fixturePhotonWasm(),
  };
}

/** Serves a built tree exactly the way a real feed would: the object at each requested path,
 * verbatim bytes, no redirects, 404 for anything not on disk. `latest` is written by the caller,
 * never by buildReleaseTree - see the "never writes latest" test below. */
function serveTree(root: string) {
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      const file = Bun.file(join(root, pathname));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
  servers.push(server);
  return { baseUrl: server.url.origin, requested };
}

/** Flips one hex character to a *different* valid hex character, so the mutated value still
 * matches updater.ts's CHECKSUM_PATTERN (/^[0-9a-f]{64}$/) and install.sh's own hex `case`
 * pattern. That is what makes this a checksum-mismatch test rather than a malformed-value test:
 * both consumers have a separate, earlier rejection for a sidecar/checksum that isn't 64 lowercase
 * hex characters at all, which is not what this is meant to exercise. */
function flipHexChar(hex: string, index: number): string {
  const alphabet = "0123456789abcdef";
  const current = hex[index]!;
  const next = alphabet[(alphabet.indexOf(current) + 1) % alphabet.length]!;
  return hex.slice(0, index) + next + hex.slice(index + 1);
}

/** A stand-in coforge-installer: it records its arguments and, like the real one, leaves the shim
 * where install.sh looks for it. It refuses any invocation other than `install --version <v>`. */
function installerStub(log: string): Uint8Array {
  return Buffer.from(
    `#!/bin/sh\n` +
      `[ "$#" -eq 3 ] && [ "$1" = install ] && [ "$2" = --version ] || exit 90\n` +
      `printf '%s\\n' "$@" > "${log}"\n` +
      `bin_directory=\${XDG_BIN_HOME:-}\n` +
      `case "$bin_directory" in\n  /*) ;;\n  *) bin_directory="$HOME/.local/bin" ;;\nesac\n` +
      `mkdir -p "$bin_directory"\n` +
      `printf '#!/bin/sh\\nexit 0\\n' > "$bin_directory/coforge-computer"\n` +
      `chmod 755 "$bin_directory/coforge-computer"\n`,
  );
}

/** Writes the installer feed the bootstrap reads, laid out as publish-installer.ts publishes it:
 * the pointer, and one gzip and sidecar for the target. */
async function writeInstallerFeed(root: string, target: string, installer: Uint8Array) {
  const directory = join(root, "installer", "0.1.0", target);
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, "installer", "latest"), "0.1.0\n");
  await writeFile(join(directory, "coforge-installer.gz"), Bun.gzipSync(installer));
  await writeFile(join(directory, "coforge-installer.sha256"), `${sha256hex(installer)}\n`);
  return join(directory, "coforge-installer.sha256");
}

async function runInstallSh(baseUrl: string): Promise<{ exitCode: number; stderr: string }> {
  const home = await tempDir("coforge-install-home-");
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "install.sh"), "--version", "latest"],
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/bash",
      COFORGE_RELEASE_FEED_URL: baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

test("version validation matches updater.ts's and both installers' isValidVersion/is_valid_version rule", () => {
  const accepted = ["3.2.1", "0.1.0-alpha.1", "1.0.0+build.5", "a", "9".repeat(100)];
  const rejected = [
    "",
    ".",
    "..",
    "-rf",
    "-1.0.0",
    "a/b",
    "a..b",
    "1.0.0..2",
    "9".repeat(101),
    "has space",
  ];
  for (const version of accepted) expect(isValidReleaseVersion(version)).toBe(true);
  for (const version of rejected) expect(isValidReleaseVersion(version)).toBe(false);
});

test("buildReleaseTree rejects an invalid version before writing anything to disk", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  for (const invalid of [".", "..", "-rf", "a/b", ""]) {
    await expect(
      buildReleaseTree(releaseInputs({ version: invalid }), outputDirectory),
    ).rejects.toThrow(/version/);
  }
  expect(await readdir(outputDirectory)).toEqual([]);
});

test("buildReleaseTree writes the full <version>/ tree and never a latest pointer", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();

  const result = await buildReleaseTree(inputs, outputDirectory);

  expect(result.version).toBe(inputs.version);
  expect(result.files).toEqual([...result.files].sort());
  expect(result.files.every((file) => !file.includes("\\") && !file.startsWith("/"))).toBe(true);
  // Publishing "latest" is the last step of the (not-yet-built) publish workflow, not of a build:
  // it must not appear in the returned file list, and no "latest" object may exist on disk.
  expect(result.files).not.toContain("latest");
  expect(result.files.some((file) => file.endsWith("/latest"))).toBe(false);
  expect(await readdir(outputDirectory)).toEqual([inputs.version]);
  await expect(stat(join(outputDirectory, "latest"))).rejects.toThrow();

  expect(result.files).toEqual(
    [
      `${inputs.version}/manifest.json`,
      `${inputs.version}/photon_rs_bg.wasm`,
      ...ALL_TARGETS.flatMap((target) => [
        `${inputs.version}/${target}/coforge-computer.gz`,
        `${inputs.version}/${target}/coforge-computer.sha256`,
      ]),
    ].sort(),
  );
});

test("buildReleaseTree writes photon_rs_bg.wasm once, uncompressed, with a manifest identity that matches an independently recomputed sha256", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();

  const { version } = await buildReleaseTree(inputs, outputDirectory);
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, version, "manifest.json"), "utf8"),
  );
  const wasmBytes = await readFile(join(outputDirectory, version, "photon_rs_bg.wasm"));

  expect(wasmBytes.equals(Buffer.from(inputs.photonWasm))).toBe(true);
  expect(manifest.photonWasm).toEqual({
    file: "photon_rs_bg.wasm",
    size: wasmBytes.byteLength,
    checksum: sha256hex(wasmBytes),
  });
});

test("every target's sidecar checksum matches the manifest's checksum, and both match an independently recomputed sha256 of the bytes on disk", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();

  const { version } = await buildReleaseTree(inputs, outputDirectory);
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, version, "manifest.json"), "utf8"),
  );

  for (const target of ALL_TARGETS) {
    const compressedComputer = await readFile(
      join(outputDirectory, version, target, "coforge-computer.gz"),
    );
    const computerBytes = Buffer.from(Bun.gunzipSync(compressedComputer));
    const independentChecksum = sha256hex(computerBytes);

    const sidecar = (
      await readFile(join(outputDirectory, version, target, "coforge-computer.sha256"), "utf8")
    ).trim();
    expect(sidecar).toBe(independentChecksum);
    expect(manifest.platforms[target].computer.checksum).toBe(independentChecksum);
    expect(manifest.platforms[target].computer.size).toBe(computerBytes.byteLength);
    expect(manifest.platforms[target].computer.binary).toBe("coforge-computer");
    expect(manifest.schema_version).toBe(2);
    expect(Object.keys(manifest.platforms[target])).toEqual(["computer"]);
    expect(manifest.platforms[target].computer.gzip).toEqual({
      binary: "coforge-computer.gz",
      size: compressedComputer.byteLength,
      checksum: sha256hex(compressedComputer),
    });
    await expect(
      stat(join(outputDirectory, version, target, "coforge-computer")),
    ).rejects.toThrow();
    await expect(
      stat(join(outputDirectory, version, target, "coforge-daemon.gz")),
    ).rejects.toThrow();
  }
});

test("buildReleaseTree produces deterministic gzip bytes", async () => {
  const first = await tempDir("coforge-release-tree-");
  const second = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();
  await buildReleaseTree(inputs, first);
  await buildReleaseTree(inputs, second);

  for (const target of ALL_TARGETS) {
    expect(
      (await readFile(join(first, inputs.version, target, "coforge-computer.gz"))).equals(
        await readFile(join(second, inputs.version, target, "coforge-computer.gz")),
      ),
    ).toBe(true);
  }
});

test("the produced tree holds, for every target, the bytes its manifest records", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();
  const { version } = await buildReleaseTree(inputs, outputDirectory);
  const manifest = ReleaseManifestSchema.parse(
    JSON.parse(await readFile(join(outputDirectory, version, "manifest.json"), "utf8")),
  );

  for (const target of ALL_TARGETS) {
    const platform = manifest.platforms[target]!.computer;
    const gzip = await readFile(join(outputDirectory, version, target, "coforge-computer.gz"));
    expect(gzip.byteLength).toBe(platform.gzip.size);
    expect(sha256hex(gzip)).toBe(platform.gzip.checksum);
    const expanded = Buffer.from(Bun.gunzipSync(gzip));
    expect(expanded.equals(Buffer.from(inputs.artifacts[target]!.computer))).toBe(true);
    expect(expanded.byteLength).toBe(platform.size);
    expect(sha256hex(expanded)).toBe(platform.checksum);
  }
  const wasm = await readFile(join(outputDirectory, version, "photon_rs_bg.wasm"));
  expect(wasm.byteLength).toBe(manifest.photonWasm.size);
  expect(sha256hex(wasm)).toBe(manifest.photonWasm.checksum);
});

test("the real install.sh installs successfully through the produced installer feed", async () => {
  const directory = await tempDir("coforge-install-sh-");
  const log = join(directory, "arguments");
  const outputDirectory = await tempDir("coforge-release-tree-");
  const { version } = await buildReleaseTree(releaseInputs(), outputDirectory);
  await writeFile(join(outputDirectory, "latest"), `${version}\n`);
  await writeInstallerFeed(outputDirectory, currentTarget(), installerStub(log));
  const { baseUrl } = serveTree(outputDirectory);

  const { exitCode, stderr } = await runInstallSh(baseUrl);

  expect(exitCode).toBe(0);
  expect(stderr).toContain("CoForge Computer installed");
  expect(stderr).toContain('/.local/bin/coforge-computer" setup --workspace <slug>');
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    "install",
    "--version",
    "latest",
  ]);
});

test("install.sh fails when one bit of an installer sidecar checksum is flipped", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const host = currentTarget();
  const { version } = await buildReleaseTree(releaseInputs(), outputDirectory);
  await writeFile(join(outputDirectory, "latest"), `${version}\n`);
  const sidecarPath = await writeInstallerFeed(outputDirectory, host, installerStub("/dev/null"));

  const original = (await readFile(sidecarPath, "utf8")).trim();
  await writeFile(sidecarPath, `${flipHexChar(original, 0)}\n`);
  const { baseUrl } = serveTree(outputDirectory);

  const { exitCode, stderr } = await runInstallSh(baseUrl);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("failed its checksum check");
});
