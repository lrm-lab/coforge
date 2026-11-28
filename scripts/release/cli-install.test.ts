import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReleaseTree, type ReleaseInputs } from "./build-release";

const script = join(import.meta.dir, "cli-install.sh");
const VERSION = "4.5.6";
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

function hostTarget(): string {
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

function cliProgram(label: string): Uint8Array {
  return Buffer.from(`#!/bin/sh\necho "standalone ${label}"\n`);
}

async function publishedFeed(label = "one") {
  const root = await tempDir("coforge-cli-feed-");
  const target = hostTarget();
  const inputs: ReleaseInputs = {
    version: VERSION,
    commit: "a".repeat(40),
    buildDate: "2026-09-04T12:00:00Z",
    photonWasm: Buffer.from("wasm"),
    artifacts: {
      [target]: { computer: Buffer.from("computer"), cli: cliProgram(label) },
      "windows-x64": { computer: Buffer.from("computer"), cli: cliProgram(label) },
    },
  };
  await buildReleaseTree(inputs, root);
  await writeFile(join(root, "latest"), `${VERSION}\n`);
  return { root, target };
}

function serve(root: string) {
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

async function runScript(baseUrl: string, args: string[], binDirectory: string, extraPath = "") {
  const home = await tempDir("coforge-cli-home-");
  const child = Bun.spawn({
    cmd: [script, ...args],
    env: {
      ...process.env,
      HOME: home,
      PATH: `${extraPath}${process.env.PATH}`,
      COFORGE_RELEASE_FEED_URL: baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
      COFORGE_BIN_DIR: binDirectory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr, home };
}

function flipFirstHexCharacter(hex: string): string {
  return (hex[0] === "0" ? "1" : "0") + hex.slice(1);
}

test("leaves the Computer-managed CLI link in place", async () => {
  const { root } = await publishedFeed();
  const { baseUrl, requested } = serve(root);
  const bin = await tempDir("coforge-cli-bin-");
  const install = await tempDir("coforge-cli-install-");
  const active = join(install, "active");
  await mkdir(active);
  const managedCli = join(active, "coforge");
  await writeFile(managedCli, "managed");
  await symlink(managedCli, join(bin, "coforge"));
  await symlink(join(active, "coforge-computer"), join(bin, "coforge-computer"));

  const { exitCode, stderr } = await runScript(baseUrl, [], bin);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("COFORGE_BIN_DIR");
  expect(await readlink(join(bin, "coforge"))).toBe(managedCli);
  expect(requested).toEqual([]);
});

test("installs the standalone cli from latest into the bin directory and touches nothing else", async () => {
  const { root } = await publishedFeed();
  const { baseUrl, requested } = serve(root);
  const bin = join(await tempDir("coforge-cli-bin-"), "nested");

  const { exitCode, stderr, home } = await runScript(baseUrl, [], bin);

  expect(exitCode).toBe(0);
  expect(stderr).toContain(`coforge ${VERSION} installed to ${bin}/coforge`);
  expect(stderr).toContain("Add it to your PATH");
  const output = Bun.spawnSync([join(bin, "coforge")]).stdout.toString();
  expect(output).toBe("standalone one\n");
  expect((await stat(join(bin, "coforge"))).mode & 0o777).toBe(0o755);
  expect(await readdir(bin)).toEqual(["coforge"]);
  expect(await readdir(home)).toEqual([]);
  expect(requested.sort()).toEqual(
    [
      "/latest",
      `/${VERSION}/manifest.json`,
      `/${VERSION}/${hostTarget()}/coforge.sha256`,
      `/${VERSION}/${hostTarget()}/coforge.gz`,
    ].sort(),
  );
});

test("no PATH hint when the bin directory is already on PATH, and a rerun upgrades in place", async () => {
  const bin = await tempDir("coforge-cli-bin-");
  const first = await publishedFeed("one");
  const second = await publishedFeed("two");

  const firstRun = await runScript(serve(first.root).baseUrl, [], bin, `${bin}:`);
  const secondRun = await runScript(
    serve(second.root).baseUrl,
    ["--version", VERSION],
    bin,
    `${bin}:`,
  );

  expect(firstRun.exitCode).toBe(0);
  expect(firstRun.stderr).not.toContain("Add it to your PATH");
  expect(secondRun.exitCode).toBe(0);
  expect(Bun.spawnSync([join(bin, "coforge")]).stdout.toString()).toBe("standalone two\n");
  expect(await readdir(bin)).toEqual(["coforge"]);
});

test("refuses an invalid version before any request", async () => {
  const { root } = await publishedFeed();
  const { baseUrl, requested } = serve(root);
  const bin = await tempDir("coforge-cli-bin-");

  for (const version of ["../x", "-rf", "a/b", ""]) {
    const { exitCode, stderr } = await runScript(baseUrl, ["--version", version], bin);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("version must be latest or a valid version string");
  }
  expect(requested).toEqual([]);
});

test("refuses a plain http feed without the test-mode switch", async () => {
  const { root } = await publishedFeed();
  const { baseUrl } = serve(root);
  const bin = await tempDir("coforge-cli-bin-");
  const child = Bun.spawn({
    cmd: [script],
    env: { ...process.env, COFORGE_RELEASE_FEED_URL: baseUrl, COFORGE_BIN_DIR: bin },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain("must use HTTPS");
});

test("a sidecar that disagrees with the manifest installs nothing", async () => {
  const { root, target } = await publishedFeed();
  const sidecar = join(root, VERSION, target, "coforge.sha256");
  await writeFile(sidecar, `${flipFirstHexCharacter((await readFile(sidecar, "utf8")).trim())}\n`);
  const bin = await tempDir("coforge-cli-bin-");

  const { exitCode, stderr } = await runScript(serve(root).baseUrl, [], bin);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("sidecar and manifest checksums disagree");
  expect(await readdir(bin)).toEqual([]);
});

test("a tampered binary fails its checksum and leaves an existing install untouched", async () => {
  const { root, target } = await publishedFeed();
  await writeFile(
    join(root, VERSION, target, "coforge.gz"),
    Bun.gzipSync(Buffer.from("#!/bin/sh\necho tampered\n")),
  );
  const bin = await tempDir("coforge-cli-bin-");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "coforge"), "previous");

  const { exitCode, stderr } = await runScript(serve(root).baseUrl, [], bin);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("failed its checksum check");
  expect(await readFile(join(bin, "coforge"), "utf8")).toBe("previous");
  expect(await readdir(bin)).toEqual(["coforge"]);
});

test("a release without a cli entry for this target is refused", async () => {
  const { root } = await publishedFeed();
  const manifestPath = join(root, VERSION, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.cli;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const bin = await tempDir("coforge-cli-bin-");

  const { exitCode, stderr } = await runScript(serve(root).baseUrl, [], bin);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("does not publish a standalone CLI");
  expect(await readdir(bin)).toEqual([]);
});
