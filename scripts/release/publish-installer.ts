#!/usr/bin/env bun
/**
 * Publishes one `coforge-installer` release to the installer feed in the release bucket
 * (docs/release/installer-feed.md), in the steps `.github/workflows/release-installer-staging.yml`
 * runs. Every step goes through publish.ts's upload flow, the one the Computer release uses:
 * objects up and verified by size and CRC-64, the version's manifest last, then the pointer with
 * the previous value saved, verified, and restored on failure. There is no second upload path here.
 *
 *   plan      refuse a version whose manifest is already up, before six runners build anything
 *   finalize  the one job that reaches the bucket with the six built binaries in hand: package
 *             them, upload and verify every object, write the manifest, then move
 *             `installer/latest`
 *   pointer   move `installer/latest` alone, forward or back, to a version that is already up
 *
 * The runners that compile the installer never get here: they hand their binary on as an artifact,
 * so no build script runs in a job that can reach the bucket.
 *
 * The version is the crate's (`crates/installer/Cargo.toml`), except for `pointer`, which names one.
 * Credentials come the way `publish.ts` gets them: GitHub OIDC through `@alicloud/credentials` in
 * CI, an AccessKey pair locally; nothing here reads or prints a secret.
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { INSTALLER_PROTOCOL } from "@coforge/computer/src/release/installer-contract";
import type OSS from "ali-oss";

import {
  assembleInstallerManifest,
  assertInstallerBinaryMatchesTarget,
  installerFileNames,
  readInstallerTargetPlatform,
  writeInstallerNotices,
  writeInstallerTargetObjects,
} from "./build-installer-release";
import { isValidReleaseVersion } from "./build-release";
import {
  INSTALLER_FEED,
  installerManifestKey,
  installerVersionFromCargoToml,
  parseInstallerManifest,
} from "./installer-feed";
import {
  assertVersionIsUnpublished,
  createOssClient,
  DEFAULT_BUCKET,
  DEFAULT_ENDPOINT,
  DEFAULT_TARGETS,
  movePointer,
  readObjectIfPresent,
  uploadReleaseTree,
  type OssConnection,
  type OssCredentials,
  type UploadResult,
} from "./publish";

export interface InstallerPublishContext {
  client: OSS;
  connection: OssConnection;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Fails a version that is already published, telling the operator which file to change. */
export async function planInstallerRelease(
  version: string,
  options: { client: OSS },
): Promise<void> {
  try {
    await assertVersionIsUnpublished(version, { client: options.client, feed: INSTALLER_FEED });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already published")) {
      throw new Error(
        `${error.message} Raise "version" in crates/installer/Cargo.toml, merge it, and publish again.`,
      );
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* The publishing job                                                                            */
/* -------------------------------------------------------------------------------------------- */

const NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";
/** The one target whose build job generates the licence notices and hands them on. */
const NOTICES_TARGET = "linux-x64";

/** The name of the artifact a target's build job uploads, and so of the directory it is downloaded
 * into. The workflow builds this name; scripts/ci/workflow.test.ts keeps the two the same. */
export function installerArtifactName(target: string): string {
  return `installer-${target}`;
}

export interface InstallerFinalizeInput {
  version: string;
  commit: string;
  /** What the build jobs handed on, one directory per artifact and never merged:
   * `<dir>/installer-<target>/coforge-installer[.exe]` for every target, and the notices in
   * `<dir>/installer-linux-x64/THIRD_PARTY_NOTICES.txt`. */
  binariesDirectory: string;
  /** Where the release tree is written. It mirrors the bucket: every path in it is an object key. */
  outputDirectory: string;
  /** ISO 8601; the moment the manifest is written unless a test fixes it. */
  buildDate?: string;
  targets?: readonly string[];
}

async function readBuilt(path: string, what: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch {
    throw new Error(`${what} is missing: ${path}`);
  }
}

/**
 * What one build job's artifact holds: the target's own binary (and, for the notices' target, the
 * notices), read from that artifact's directory alone. Every artifact is a separate directory, so
 * one build job cannot replace another target's file; and an artifact carrying anything but its
 * expected files, another target's binary name, a directory, or a link is refused rather than
 * ignored. The binary must also be the executable format and CPU of its target.
 */
async function readTargetArtifact(
  binariesDirectory: string,
  target: string,
): Promise<{ binary: Uint8Array; notices?: Uint8Array }> {
  const directory = join(binariesDirectory, installerArtifactName(target));
  const binaryName = installerFileNames(target).binary;
  const expected = new Set<string>([binaryName]);
  if (target === NOTICES_TARGET) expected.add(NOTICES_FILE);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(`the ${target} installer was not built: ${directory} is missing`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !expected.has(entry.name)) {
      throw new Error(
        `the ${target} build artifact holds ${entry.name}, which is not one of its files ` +
          `(${[...expected].join(", ")}); ${directory}`,
      );
    }
  }
  const binary = await readBuilt(join(directory, binaryName), `the ${target} installer`);
  assertInstallerBinaryMatchesTarget(target, binary);
  if (target !== NOTICES_TARGET) return { binary };
  return {
    binary,
    notices: await readBuilt(
      join(directory, NOTICES_FILE),
      `${NOTICES_FILE} (the ${NOTICES_TARGET} job generates it)`,
    ),
  };
}

/**
 * Packages the built binaries into a complete release tree, locally: each target's gzip and
 * sidecar, the notices, and the manifest. Every target's identity is derived from the packaged
 * bytes, so the manifest is a hash of exactly what will be uploaded, and a target that was not
 * built, or a release without its notices, stops here, before the bucket is asked anything.
 */
async function packageReleaseTree(input: InstallerFinalizeInput) {
  const targets = input.targets ?? DEFAULT_TARGETS;
  const files: string[] = [];
  let notices: Uint8Array | undefined;
  for (const target of targets) {
    const artifact = await readTargetArtifact(input.binariesDirectory, target);
    if (artifact.notices) notices = artifact.notices;
    files.push(
      ...(await writeInstallerTargetObjects(
        { version: input.version, target, binary: artifact.binary },
        input.outputDirectory,
      )),
    );
  }
  if (!notices) {
    throw new Error(`${NOTICES_FILE} is missing (the ${NOTICES_TARGET} job generates it)`);
  }
  files.push(await writeInstallerNotices(input.version, notices, input.outputDirectory));

  const platforms: Record<string, Awaited<ReturnType<typeof readInstallerTargetPlatform>>> = {};
  for (const target of targets) {
    platforms[target] = await readInstallerTargetPlatform(
      input.version,
      target,
      input.outputDirectory,
    );
  }
  const manifest = assembleInstallerManifest({
    version: input.version,
    commit: input.commit,
    buildDate: input.buildDate ?? new Date().toISOString(),
    installerProtocol: INSTALLER_PROTOCOL,
    platforms,
  });
  const manifestKey = installerManifestKey(input.version);
  await Bun.write(
    join(input.outputDirectory, manifestKey),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  files.push(manifestKey);
  return { version: input.version, files: files.sort() };
}

/**
 * The publication of an installer release: package the six binaries, refuse a version whose
 * manifest is up, upload every object and read it back, write the manifest last, and only then
 * move `installer/latest`. Objects a failed earlier run left beneath a version with no manifest are
 * unreferenced and are replaced, exactly as for the Computer feed.
 */
export async function finalizeInstaller(
  input: InstallerFinalizeInput,
  context: InstallerPublishContext,
): Promise<UploadResult> {
  const tree = await packageReleaseTree(input);
  return uploadReleaseTree(input.outputDirectory, tree, { ...context, feed: INSTALLER_FEED });
}

/* -------------------------------------------------------------------------------------------- */
/* pointer_only                                                                                  */
/* -------------------------------------------------------------------------------------------- */

function assertPointerVersion(version: string): void {
  if (!isValidReleaseVersion(version)) {
    throw new Error(
      `the pointer version must be a valid version string: ${JSON.stringify(version)}`,
    );
  }
}

/**
 * Moves `installer/latest` to `version`, forward or back, and writes nothing else. The pointer is
 * only ever aimed at a version whose manifest is up and readable, so a typo cannot leave every
 * machine resolving an installer that does not exist.
 */
export async function moveInstallerPointer(
  version: string,
  context: InstallerPublishContext,
): Promise<void> {
  assertPointerVersion(version);
  const key = installerManifestKey(version);
  const bytes = await readObjectIfPresent(context.client, key);
  if (!bytes) {
    throw new Error(
      `installer ${version} is not published (${key} is absent); the pointer only moves to a published version`,
    );
  }
  const manifest = parseInstallerManifest(bytes);
  if (!manifest || manifest.version !== version) {
    throw new Error(`${key} is not a complete installer manifest for ${version}`);
  }
  context.log?.(`installer ${version} speaks installer protocol ${manifest.installer_protocol}`);
  await movePointer({ ...context, feed: INSTALLER_FEED, version });
}

/* -------------------------------------------------------------------------------------------- */
/* CLI                                                                                            */
/* -------------------------------------------------------------------------------------------- */

const DEFAULT_CARGO_TOML = fileURLToPath(
  new URL("../../crates/installer/Cargo.toml", import.meta.url),
);

const FLAGS = {
  common: ["--bucket", "--endpoint", "--region"],
  plan: ["--cargo-toml"],
  finalize: ["--cargo-toml", "--commit", "--binaries", "--out", "--dry-run"],
  pointer: ["--version"],
} as const;

type Command = keyof Omit<typeof FLAGS, "common">;
type Args = Map<string, string | true>;

function parseArgv(argv: string[]): { command: Command; args: Args } {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error("a command is required: plan, finalize, or pointer");
  if (!Object.hasOwn(FLAGS, command) || command === "common") {
    throw new Error(`unknown command: ${command}`);
  }
  const allowed: readonly string[] = [...FLAGS.common, ...FLAGS[command as Command]];
  const args: Args = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (!allowed.includes(flag)) throw new Error(`unknown argument: ${flag}`);
    if (flag === "--dry-run") {
      args.set(flag, true);
      continue;
    }
    const value = rest[(index += 1)];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    args.set(flag, value);
  }
  return { command: command as Command, args };
}

function required(args: Args, flag: string): string {
  const value = args.get(flag);
  if (typeof value !== "string" || value.length === 0) throw new Error(`${flag} is required`);
  return value;
}

async function crateVersion(args: Args): Promise<string> {
  const path = (args.get("--cargo-toml") as string | undefined) ?? DEFAULT_CARGO_TOML;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  return installerVersionFromCargoToml(text);
}

export interface InstallerCliDependencies {
  /** Static credentials for tests; a real run resolves them from the Alibaba Cloud chain. */
  credentials?: OssCredentials;
  /** Points requests at a fixture server instead of the real bucket. */
  connection?: Partial<OssConnection>;
  fetchImpl?: typeof fetch;
  /** Builds the OSS client; tests pass one that records whether it was asked for. */
  createClient?: typeof createOssClient;
}

export async function runInstallerCli(
  argv: string[],
  deps: InstallerCliDependencies = {},
): Promise<number> {
  try {
    const { command, args } = parseArgv(argv);
    const log = (line: string): void => console.log(line);
    // Everything a step names is checked before a credential is resolved or a file is touched: the
    // chain can wait on a metadata service, and an operator's typo should not.
    const pointerVersion = command === "pointer" ? required(args, "--version") : undefined;
    if (pointerVersion !== undefined) assertPointerVersion(pointerVersion);
    if (command === "finalize") {
      required(args, "--commit");
      required(args, "--binaries");
      required(args, "--out");
    }
    const version = command === "pointer" ? undefined : await crateVersion(args);

    const connection: OssConnection = {
      bucket: (args.get("--bucket") as string | undefined) ?? DEFAULT_BUCKET,
      endpoint: (args.get("--endpoint") as string | undefined) ?? DEFAULT_ENDPOINT,
      region: args.get("--region") as string | undefined,
      cname: false,
      secure: true,
      ...deps.connection,
    };
    const dryRun = args.get("--dry-run") === true;
    const client = dryRun
      ? undefined
      : await (deps.createClient ?? createOssClient)(connection, deps.credentials);
    const context = client ? { client, connection, fetchImpl: deps.fetchImpl, log } : undefined;

    if (pointerVersion !== undefined) {
      await moveInstallerPointer(pointerVersion, context!);
      log(`installer/latest -> ${pointerVersion}`);
      return 0;
    }

    if (command === "plan") {
      await planInstallerRelease(version!, { client: client! });
      log(`installer ${version} is not published yet`);
      if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
      return 0;
    }

    const input: InstallerFinalizeInput = {
      version: version!,
      commit: required(args, "--commit"),
      binariesDirectory: required(args, "--binaries"),
      outputDirectory: required(args, "--out"),
    };
    if (!context) {
      const tree = await packageReleaseTree(input);
      log("dry run: no network calls made. Objects that would be published:");
      for (const file of tree.files) log(`  ${file}`);
      log(`  ${INSTALLER_FEED.latestKey} (-> ${version})`);
      return 0;
    }
    const result = await finalizeInstaller(input, context);
    log(`published ${result.uploaded.length} objects and ${result.latestKey} -> ${version}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`installer publish failed: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runInstallerCli(process.argv.slice(2));
}
