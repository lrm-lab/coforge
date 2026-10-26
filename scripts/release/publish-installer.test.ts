import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INSTALLER_PROTOCOL,
  InstallerManifestSchema,
} from "@coforge/computer/src/release/installer-contract";
import type OSS from "ali-oss";

import { installerFileNames, readInstallerTargetPlatform } from "./build-installer-release";
import {
  ELF_MACHINE,
  MACH_O_CPU,
  elfHeader,
  machOHeader,
  syntheticBinaryWithHeader,
  syntheticInstallerBinary,
} from "./fixtures/installer-binary";
import {
  CREDENTIALS,
  fixtureConnection,
  startFakeOssServer,
  startLeakFixtureServer,
  stopFakeOssServers,
  type FakeOss,
} from "./fixtures/fake-oss";
import { INSTALLER_FEED } from "./installer-feed";
import { createOssClient, DEFAULT_TARGETS, type OssConnection } from "./publish";
import {
  finalizeInstaller,
  installerArtifactName,
  moveInstallerPointer,
  planInstallerRelease,
  runInstallerCli,
} from "./publish-installer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  stopFakeOssServers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-publish-installer-"));
  temporaryDirectories.push(directory);
  return directory;
}

const VERSION = "9.8.7";
const COMMIT = "c".repeat(40);
const BUILD_DATE = "2026-09-30T08:00:00.000Z";
const NOTICES = "third party notices\n";
const LATEST = "installer/latest";
const MANIFEST = `installer/${VERSION}/manifest.json`;

const golden = JSON.parse(
  await readFile(
    new URL("../../crates/installer/contract/installer-manifest.v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

/** A complete installer manifest for another version, as an earlier publication left it. */
function publishedManifest(version: string, installerProtocol = INSTALLER_PROTOCOL): string {
  return JSON.stringify({ ...golden, version, installer_protocol: installerProtocol });
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

async function connect(fake: FakeOss): Promise<{ client: OSS; connection: OssConnection }> {
  const connection = fixtureConnection(fake);
  return { client: await createOssClient(connection, CREDENTIALS), connection };
}

/** What the six build jobs hand on, downloaded side by side: one directory per artifact, holding
 * that target's built binary, and the notices in the one artifact that generates them. */
async function builtBinaries(
  options: { without?: string; notices?: boolean } = {},
): Promise<string> {
  const directory = await tempDir();
  for (const target of DEFAULT_TARGETS) {
    if (target === options.without) continue;
    const artifact = join(directory, installerArtifactName(target));
    await mkdir(artifact, { recursive: true });
    await writeFile(
      join(artifact, installerFileNames(target).binary),
      syntheticInstallerBinary(target),
    );
  }
  if (options.notices !== false) {
    await writeFile(
      join(directory, installerArtifactName("linux-x64"), "THIRD_PARTY_NOTICES.txt"),
      NOTICES,
    );
  }
  return directory;
}

async function finalizeFrom(fake: FakeOss, options: { binaries?: string; output?: string } = {}) {
  const { client, connection } = await connect(fake);
  const output = options.output ?? (await tempDir());
  const result = await finalizeInstaller(
    {
      version: VERSION,
      commit: COMMIT,
      buildDate: BUILD_DATE,
      binariesDirectory: options.binaries ?? (await builtBinaries()),
      outputDirectory: output,
    },
    { client, connection },
  );
  return { result, output };
}

/* ------------------------------------------------------------------------------------------- */
/* plan                                                                                          */
/* ------------------------------------------------------------------------------------------- */

test("planning refuses a published version early and says which file to change", async () => {
  const fake = startFakeOssServer({ preexistingKeys: new Set([MANIFEST]) });
  const { client } = await connect(fake);

  await expect(planInstallerRelease(VERSION, { client })).rejects.toThrow(
    /already published.*crates\/installer\/Cargo\.toml/s,
  );
  expect(fake.calls).toEqual([{ method: "HEAD", key: MANIFEST }]);

  const fresh = startFakeOssServer();
  await planInstallerRelease(VERSION, { client: (await connect(fresh)).client });
});

/* ------------------------------------------------------------------------------------------- */
/* The publishing job: package, upload, verify, manifest, pointer                               */
/* ------------------------------------------------------------------------------------------- */

test("the publishing job uploads every object, writes the manifest after them all, and only then moves installer/latest", async () => {
  const fake = startFakeOssServer();
  const output = await tempDir();

  const { result } = await finalizeFrom(fake, { output });

  const objectKeys = [
    `installer/${VERSION}/THIRD_PARTY_NOTICES.txt`,
    ...DEFAULT_TARGETS.flatMap((target) => [
      `installer/${VERSION}/${target}/${installerFileNames(target).gzip}`,
      `installer/${VERSION}/${target}/coforge-installer.sha256`,
    ]),
  ].sort();
  expect(result.latestKey).toBe(LATEST);
  expect(result.uploaded).toEqual([...objectKeys, MANIFEST].sort());
  expect(fake.calls.filter((call) => call.method === "PUT")).toEqual([
    ...objectKeys.map((key) => ({ method: "PUT", key })),
    { method: "PUT", key: MANIFEST },
    { method: "PUT", key: LATEST },
  ]);
  // It asked whether the version was published, and read the pointer it must not move back,
  // before writing anything; and read every object back, and proved the origin private, before the
  // pointer was written.
  expect(fake.calls.slice(0, 2)).toEqual([
    { method: "HEAD", key: MANIFEST },
    { method: "GET", key: LATEST },
  ]);
  const pointerCalls = fake.calls.findIndex((call) => call.method === "PUT" && call.key === LATEST);
  for (const kind of ["GET", "ANONYMOUS_GET"]) {
    for (const key of [...objectKeys, MANIFEST]) {
      const index = fake.calls.findIndex((call) => call.method === kind && call.key === key);
      expect(index, `${kind} ${key}`).toBeGreaterThan(-1);
      expect(index, `${kind} ${key}`).toBeLessThan(pointerCalls);
    }
  }
  // What is in the bucket is what was packaged.
  for (const key of [...objectKeys, MANIFEST]) {
    expect(
      Buffer.compare(Buffer.from(fake.peek(key)!), await readFile(join(output, key))),
      key,
    ).toBe(0);
  }
  expect(text(fake.peek(LATEST))).toBe(`${VERSION}\n`);

  const manifest = InstallerManifestSchema.parse(JSON.parse(text(fake.peek(MANIFEST))));
  expect(manifest).toMatchObject({
    schema_version: 1,
    version: VERSION,
    commit: COMMIT,
    buildDate: BUILD_DATE,
    installer_protocol: INSTALLER_PROTOCOL,
  });
  expect(Object.keys(manifest.platforms).sort()).toEqual([...DEFAULT_TARGETS].sort());
  // Each entry is the identity of the objects in the bucket, not what a job claims.
  for (const target of DEFAULT_TARGETS) {
    expect(manifest.platforms[target]).toEqual(
      await readInstallerTargetPlatform(VERSION, target, output),
    );
  }
});

test("a version that is not built for all six targets is refused before the bucket is asked anything", async () => {
  const fake = startFakeOssServer();

  await expect(
    finalizeFrom(fake, { binaries: await builtBinaries({ without: "windows-arm64" }) }),
  ).rejects.toThrow(/windows-arm64.*was not built/);

  expect(fake.calls).toEqual([]);
});

test("a version without its licence notices is refused before the bucket is asked anything", async () => {
  const fake = startFakeOssServer();

  await expect(
    finalizeFrom(fake, { binaries: await builtBinaries({ notices: false }) }),
  ).rejects.toThrow(/THIRD_PARTY_NOTICES\.txt/);

  expect(fake.calls).toEqual([]);
});

/** Packages `binaries` and expects the refusal, having asked the bucket nothing. */
async function expectRefusedLocally(binaries: string, message: RegExp) {
  const fake = startFakeOssServer();
  await expect(finalizeFrom(fake, { binaries })).rejects.toThrow(message);
  expect(fake.calls).toEqual([]);
}

test("a build artifact with a file beyond its own binary is refused, so nothing rides along", async () => {
  const binaries = await builtBinaries();
  await writeFile(join(binaries, installerArtifactName("linux-arm64"), "extra.txt"), "x");

  await expectRefusedLocally(binaries, /linux-arm64.*extra\.txt/);
});

test("a file named for another target's binary is refused, whether it comes with the right one or instead of it", async () => {
  const withBoth = await builtBinaries();
  await writeFile(
    join(withBoth, installerArtifactName("linux-x64"), "coforge-installer.exe"),
    syntheticInstallerBinary("windows-x64"),
  );
  await expectRefusedLocally(withBoth, /linux-x64.*coforge-installer\.exe/);

  // A Windows target whose artifact holds the POSIX name instead of its own.
  const wrongName = await builtBinaries();
  const windows = join(wrongName, installerArtifactName("windows-x64"));
  await rm(join(windows, "coforge-installer.exe"));
  await writeFile(join(windows, "coforge-installer"), syntheticInstallerBinary("windows-x64"));
  await expectRefusedLocally(wrongName, /windows-x64.*coforge-installer\b(?!\.)/);
});

test("the notices are accepted from the one artifact that generates them, and from no other", async () => {
  const binaries = await builtBinaries();
  await writeFile(
    join(binaries, installerArtifactName("darwin-arm64"), "THIRD_PARTY_NOTICES.txt"),
    "forged notices\n",
  );

  await expectRefusedLocally(binaries, /darwin-arm64.*THIRD_PARTY_NOTICES\.txt/);
});

test("a directory or a link inside a build artifact is refused, not followed", async () => {
  const withDirectory = await builtBinaries();
  await mkdir(join(withDirectory, installerArtifactName("darwin-x64"), "nested"));
  await expectRefusedLocally(withDirectory, /darwin-x64.*nested/);

  const withLink = await builtBinaries();
  const artifact = join(withLink, installerArtifactName("darwin-arm64"));
  await rm(join(artifact, "coforge-installer"));
  await symlink(
    join(withLink, installerArtifactName("darwin-x64"), "coforge-installer"),
    join(artifact, "coforge-installer"),
  );
  await expectRefusedLocally(withLink, /darwin-arm64.*coforge-installer/);
});

test("a binary of the wrong CPU, or no executable at all, is refused before the bucket is asked anything", async () => {
  const wrongCpu = await builtBinaries();
  await writeFile(
    join(wrongCpu, installerArtifactName("darwin-arm64"), "coforge-installer"),
    syntheticBinaryWithHeader(machOHeader(MACH_O_CPU.x86_64)),
  );
  await expectRefusedLocally(wrongCpu, /darwin-arm64.*x86_64.*not arm64/);

  const wrongFormat = await builtBinaries();
  await writeFile(
    join(wrongFormat, installerArtifactName("linux-x64"), "coforge-installer"),
    syntheticBinaryWithHeader(machOHeader(MACH_O_CPU.arm64)),
  );
  await expectRefusedLocally(wrongFormat, /linux-x64 installer is not a 64-bit little-endian ELF/);

  const script = await builtBinaries();
  await writeFile(
    join(script, installerArtifactName("linux-arm64"), "coforge-installer"),
    "#!/bin/sh\necho installer\n",
  );
  await expectRefusedLocally(script, /linux-arm64 installer is not a 64-bit little-endian ELF/);

  // The right CPU passes: the same artifact set with its own headers is what every other test packages.
  const right = await builtBinaries();
  await writeFile(
    join(right, installerArtifactName("linux-arm64"), "coforge-installer"),
    syntheticBinaryWithHeader(elfHeader(ELF_MACHINE.aarch64), "rebuilt"),
  );
  await finalizeFrom(startFakeOssServer(), { binaries: right });
});

test("a version whose manifest already exists is refused and nothing is written", async () => {
  const fake = startFakeOssServer({ preexistingKeys: new Set([MANIFEST]) });

  await expect(finalizeFrom(fake)).rejects.toThrow(/9\.8\.7 is already published/);

  // Published objects are write-once: the version's bytes are never touched.
  expect(fake.calls).toEqual([{ method: "HEAD", key: MANIFEST }]);
});

test("objects an earlier failed run left under a version with no manifest are replaced", async () => {
  const leftover = `installer/${VERSION}/darwin-x64/coforge-installer.gz`;
  const fake = startFakeOssServer({ preexistingKeys: new Set([leftover]) });
  const output = await tempDir();

  await finalizeFrom(fake, { output });

  expect(
    Buffer.compare(Buffer.from(fake.peek(leftover)!), await readFile(join(output, leftover))),
  ).toBe(0);
  expect(text(fake.peek(LATEST))).toBe(`${VERSION}\n`);
});

test("an object that cannot be uploaded stops the job before the manifest and the pointer", async () => {
  const fake = startFakeOssServer({
    failUploadKeys: new Set([`installer/${VERSION}/linux-arm64/coforge-installer.gz`]),
  });

  await expect(finalizeFrom(fake)).rejects.toThrow(/OSS upload failed: HTTP 500/);

  expect(fake.peek(MANIFEST)).toBeUndefined();
  expect(fake.peek(LATEST)).toBeUndefined();
});

for (const previous of ["0.0.9\n", undefined]) {
  test(`a pointer that cannot be verified after the manifest is written is put back to ${previous ? "the previous installer" : "nothing"}`, async () => {
    const fake = startFakeOssServer({
      preexistingObjects: previous ? { [LATEST]: previous } : {},
      tamperReadbackKeys: new Set([LATEST]),
    });

    await expect(finalizeFrom(fake)).rejects.toThrow(/activation failed.*restored/);

    if (previous) expect(text(fake.peek(LATEST))).toBe(previous);
    else expect(fake.peek(LATEST)).toBeUndefined();
  });
}

/* ------------------------------------------------------------------------------------------- */
/* pointer_only: move installer/latest alone                                                    */
/* ------------------------------------------------------------------------------------------- */

const OLD = "0.1.0";
const NEW = "0.2.0";
const twoInstallers = {
  [LATEST]: `${NEW}\n`,
  [`installer/${OLD}/manifest.json`]: publishedManifest(OLD),
  [`installer/${NEW}/manifest.json`]: publishedManifest(NEW),
};

for (const [direction, from, to] of [
  ["back", NEW, OLD],
  ["forward", OLD, NEW],
] as const) {
  test(`the pointer moves ${direction} to a published installer and nothing else is written`, async () => {
    const fake = startFakeOssServer({
      preexistingObjects: { ...twoInstallers, [LATEST]: `${from}\n` },
    });
    const { client, connection } = await connect(fake);

    await moveInstallerPointer(to, { client, connection });

    expect(text(fake.peek(LATEST))).toBe(`${to}\n`);
    expect(fake.calls.filter((call) => call.method === "PUT")).toEqual([
      { method: "PUT", key: LATEST },
    ]);
    // It looked before it moved: the target's manifest, then the pointer it replaces.
    expect(fake.calls.slice(0, 3)).toEqual([
      { method: "GET", key: `installer/${to}/manifest.json` },
      { method: "HEAD", key: LATEST },
      { method: "GET", key: LATEST },
    ]);
  });
}

test("the pointer never moves to a version that has no manifest", async () => {
  const fake = startFakeOssServer({ preexistingObjects: twoInstallers });
  const { client, connection } = await connect(fake);

  await expect(moveInstallerPointer("0.9.9", { client, connection })).rejects.toThrow(
    /installer\/0\.9\.9\/manifest\.json/,
  );

  expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
  expect(text(fake.peek(LATEST))).toBe(`${NEW}\n`);
});

test("the pointer never moves to a manifest that is not that version's complete manifest", async () => {
  const fake = startFakeOssServer({
    preexistingObjects: {
      ...twoInstallers,
      "installer/0.3.0/manifest.json": publishedManifest("0.2.5"),
      "installer/0.4.0/manifest.json": JSON.stringify({
        ...golden,
        version: "0.4.0",
        installer_protocol: "1",
      }),
      "installer/0.5.0/manifest.json": "not json",
    },
  });
  const { client, connection } = await connect(fake);

  for (const version of ["0.3.0", "0.4.0", "0.5.0"]) {
    await expect(moveInstallerPointer(version, { client, connection })).rejects.toThrow(
      /not a complete installer manifest/,
    );
  }
  expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("a pointer version that could name another path is refused before the bucket is asked", async () => {
  const fake = startFakeOssServer({ preexistingObjects: twoInstallers });
  const { client, connection } = await connect(fake);

  for (const version of ["../0.1.0", "0.1.0/../0.2.0", "", "-0.1.0"]) {
    await expect(moveInstallerPointer(version, { client, connection })).rejects.toThrow(
      /valid version string/,
    );
  }
  expect(fake.calls).toEqual([]);
});

test("a pointer move that cannot be verified restores the previous pointer", async () => {
  const fake = startFakeOssServer({
    preexistingObjects: { ...twoInstallers, [LATEST]: `${NEW}\n` },
    tamperReadbackKeys: new Set([LATEST]),
  });
  const { client, connection } = await connect(fake);

  await expect(moveInstallerPointer(OLD, { client, connection })).rejects.toThrow(
    /activation failed.*restored/,
  );

  expect(text(fake.peek(LATEST))).toBe(`${NEW}\n`);
});

test("the installer feed layout is the one the workflow, the docs and the clients name", () => {
  expect(INSTALLER_FEED.latestKey).toBe("installer/latest");
  expect(INSTALLER_FEED.manifestKey("0.1.0")).toBe("installer/0.1.0/manifest.json");
});

/* ------------------------------------------------------------------------------------------- */
/* Command line                                                                                  */
/* ------------------------------------------------------------------------------------------- */

async function cargoToml(directory: string, version: string): Promise<string> {
  const path = join(directory, "Cargo.toml");
  await writeFile(path, `[package]\nname = "coforge-installer"\nversion = "${version}"\n`);
  return path;
}

async function cli(
  argv: string[],
  fake?: FakeOss,
  extra: Partial<Parameters<typeof runInstallerCli>[1]> = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    const exitCode = await runInstallerCli(argv, {
      credentials: CREDENTIALS,
      ...(fake ? { connection: { endpoint: fake.baseUrl, cname: true, secure: false } } : {}),
      ...extra,
    });
    return { exitCode, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const bucketFlags = ["--bucket", "coforge-releases-test", "--region", "oss-cn-beijing"];

test("the command line takes its version from the crate, then publishes and moves the pointer", async () => {
  const directory = await tempDir();
  const fake = startFakeOssServer();
  const cargo = await cargoToml(directory, VERSION);
  const githubOutput = join(directory, "github-output");
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = githubOutput;
  try {
    const plan = await cli(["plan", "--cargo-toml", cargo, ...bucketFlags], fake);
    expect(plan.exitCode).toBe(0);
    expect(await readFile(githubOutput, "utf8")).toBe(`version=${VERSION}\n`);
    expect(fake.peek(LATEST)).toBeUndefined();

    const finalize = await cli(
      [
        "finalize",
        "--cargo-toml",
        cargo,
        "--commit",
        COMMIT,
        "--binaries",
        await builtBinaries(),
        "--out",
        join(directory, "out"),
        ...bucketFlags,
      ],
      fake,
    );
    expect(finalize.stderr).toEqual([]);
    expect(finalize.exitCode).toBe(0);
    expect(text(fake.peek(LATEST))).toBe(`${VERSION}\n`);

    // Forward is the version just published; back is any version whose manifest is up.
    const pointer = await cli(["pointer", "--version", VERSION, ...bucketFlags], fake);
    expect(pointer.exitCode).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
  }
});

test("a dry run packages the tree and lists what it would publish without a client or a network call", async () => {
  const directory = await tempDir();
  const fake = startFakeOssServer();
  const cargo = await cargoToml(directory, VERSION);
  const out = join(directory, "out");
  const createClient = () => {
    throw new Error("a dry run must not create an OSS client");
  };

  const dry = await cli(
    [
      "finalize",
      "--dry-run",
      "--cargo-toml",
      cargo,
      "--commit",
      COMMIT,
      "--binaries",
      await builtBinaries(),
      "--out",
      out,
      ...bucketFlags,
    ],
    fake,
    { createClient },
  );

  expect(dry.stderr).toEqual([]);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.join("\n")).toContain(`installer/${VERSION}/manifest.json`);
  expect(dry.stdout.join("\n")).toContain(`installer/${VERSION}/linux-x64/coforge-installer.gz`);
  expect(dry.stdout.join("\n")).toContain("installer/latest");
  expect(fake.calls).toEqual([]);
  expect(await readFile(join(out, MANIFEST), "utf8")).toContain(`"version": "${VERSION}"`);
});

test("the command line names the flag or command it did not understand and exits 1", async () => {
  const directory = await tempDir();
  const cargo = await cargoToml(directory, VERSION);
  const failures: Array<[string[], RegExp]> = [
    [[], /a command is required/],
    [["publish"], /unknown command: publish/],
    [["objects"], /unknown command: objects/],
    [["plan", "--cargo-toml", cargo, "--bogus"], /unknown argument: --bogus/],
    [["plan", "--cargo-toml", cargo, "--dry-run"], /unknown argument: --dry-run/],
    [["finalize", "--cargo-toml", cargo, "--binaries", "x", "--out", "y"], /--commit is required/],
    [
      ["finalize", "--cargo-toml", cargo, "--commit", COMMIT, "--out", "y"],
      /--binaries is required/,
    ],
    [
      ["finalize", "--cargo-toml", cargo, "--commit", COMMIT, "--binaries", "x"],
      /--out is required/,
    ],
    [["pointer"], /--version is required/],
    [["plan", "--cargo-toml", join(directory, "missing.toml")], /missing\.toml/],
  ];
  for (const [argv, message] of failures) {
    const result = await cli(argv);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toMatch(message);
    expect(result.stderr.join("\n")).toMatch(/^installer publish failed: /);
  }
});

test("an invalid version is refused before any credential is resolved or client created", async () => {
  const directory = await tempDir();
  const clients: string[] = [];
  const createClient = (async () => {
    clients.push("created");
    throw new Error("the credential chain would have been consulted");
  }) as typeof createOssClient;

  // The pointer version comes from the operator; the crate version from a file that can be wrong.
  const pointer = await cli(["pointer", "--version", "../0.1.0"], undefined, { createClient });
  const badCrate = await cli(
    ["plan", "--cargo-toml", await cargoToml(directory, "1.0/../x")],
    undefined,
    { createClient },
  );

  expect(pointer.exitCode).toBe(1);
  expect(pointer.stderr.join("\n")).toMatch(/valid version string/);
  expect(badCrate.exitCode).toBe(1);
  expect(badCrate.stderr.join("\n")).toMatch(/no valid \[package\] version/);
  expect(clients).toEqual([]);
});

test("a failed installer publication never prints the access key or its secret", async () => {
  const directory = await tempDir();
  const cargo = await cargoToml(directory, VERSION);
  const server = startLeakFixtureServer(
    `<Error><Code>SignatureDoesNotMatch</Code><AccessKeyId>${CREDENTIALS.accessKeyId}</AccessKeyId><StringToSign>s</StringToSign><Message>${CREDENTIALS.accessKeySecret}</Message></Error>`,
  );
  try {
    const result = await cli(["plan", "--cargo-toml", cargo, ...bucketFlags], {
      baseUrl: server.baseUrl,
    } as FakeOss);
    const combined = [...result.stdout, ...result.stderr].join("\n");
    expect(result.exitCode).toBe(1);
    expect(combined).not.toContain(CREDENTIALS.accessKeyId);
    expect(combined).not.toContain(CREDENTIALS.accessKeySecret);
    expect(combined).not.toContain("StringToSign");
  } finally {
    server.stop();
  }
});
