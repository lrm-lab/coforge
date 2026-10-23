import { readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { z } from "zod";
import { isValidReleaseVersion } from "@lrm/coforge-sdk/internal";

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
// Matches the pointer file, a version directory, and a manifest.json platform entry: a bare
// version string with no path separators and no traversal segment.

/** A version is both a URL segment and an on-disk directory name under "versions/", so beyond
 * the character-class pattern above it must reject two further values that pattern alone would
 * accept: "." on its own, which as a directory name means "the versions directory itself" and
 * would let a payload land outside any per-version directory (a lone "." never triggers the
 * "*.." substring check, which only catches two consecutive dots); and a leading "-", which
 * would let the value be mistaken for a flag by curl, a shell, or any other tool it later
 * reaches. #assertVersion must go through this single function. */
const isValidVersion = isValidReleaseVersion;

/* The zod schemas below are the cross-language contract with the Rust installer: the installer
 * writes active.json and installation.json and reads the release manifest, and
 * `bun run generate:installer-contract` exports them as JSON Schema plus golden instances into
 * crates/installer/contract/. Every object is loose: a later version only ever adds fields, and a reader
 * ignores the ones it does not know. installer-contract.test.ts parses the installer's goldens
 * with these schemas. */

export const ArtifactIdentitySchema = z.looseObject({
  size: z.number().int().nonnegative(),
  checksum: z.string().regex(CHECKSUM_PATTERN),
});

const PlatformArtifactSchema = z.looseObject({
  binary: z.literal("coforge-computer"),
  ...ArtifactIdentitySchema.shape,
  gzip: z.looseObject({
    binary: z.literal("coforge-computer.gz"),
    ...ArtifactIdentitySchema.shape,
  }),
});

/** Pi's image-resize WASM: one platform-independent object per version, named explicitly (not
 * merely "some safe filename") the same way a per-target `binary` field is - see
 * docs/release/local-distribution.md's feed layout. */
const PhotonWasmArtifactSchema = z.looseObject({
  file: z.literal("photon_rs_bg.wasm"),
  ...ArtifactIdentitySchema.shape,
});

/** `<version>/manifest.json`. `installer_protocol` is additive to schema 2: the lowest
 * coforge-installer protocol that can install this version. */
export const ReleaseManifestSchema = z
  .looseObject({
    schema_version: z.literal(2),
    version: z.string(),
    commit: z.string(),
    buildDate: z.string(),
    // A platform entry holds exactly the computer artifact: no daemon payload exists.
    platforms: z.record(z.string(), z.strictObject({ computer: PlatformArtifactSchema })),
    photonWasm: PhotonWasmArtifactSchema,
    installer_protocol: z.number().int().positive().optional(),
  })
  .meta({ title: "CoForge release manifest" });

/** `<install root>/active.json`: the selected version and the one before it. */
export const ActiveStateSchema = z
  .looseObject({
    schema_version: z.literal(1),
    current: z.string(),
    previous: z.string().nullable(),
  })
  .meta({ title: "CoForge active version" });
type ActiveState = z.infer<typeof ActiveStateSchema>;

const InstalledIdentityV2Schema = z.looseObject({
  schema_version: z.literal(2),
  version: z.string(),
  computer: ArtifactIdentitySchema,
  agentCli: ArtifactIdentitySchema,
});

const InstalledIdentityV3Schema = z.looseObject({
  ...InstalledIdentityV2Schema.shape,
  schema_version: z.literal(3),
  githubCli: ArtifactIdentitySchema,
});

/** photon_rs_bg.wasm joins the installed identity here, not in schema 3: dev policy is no
 * compatibility fallback, so every version installed from here on ships and verifies it. Schemas
 * 2 and 3 remain valid only because older retained versions (rollback targets) were installed
 * before this field existed. */
const InstalledIdentityV4Schema = z.looseObject({
  ...InstalledIdentityV3Schema.shape,
  schema_version: z.literal(4),
  photonWasm: ArtifactIdentitySchema,
});

/** `versions/<version>/installation.json`. New installations write schema 4. */
export const InstalledIdentitySchema = z
  .discriminatedUnion("schema_version", [
    InstalledIdentityV2Schema,
    InstalledIdentityV3Schema,
    InstalledIdentityV4Schema,
  ])
  .meta({ title: "CoForge installed version identity" });

/** The machine mutation lock, relative to the install root. Held for a whole install or upgrade, and probed by `status`. */
export const MACHINE_MUTATION_LOCK_FILE = "machine-mutation-lock.sqlite";

/** The version-local `coforge` launcher that runs the adjacent executable's Agent CLI. */
export function agentCliLauncher(windows: boolean): string {
  return windows
    ? '@echo off\r\n"%~dp0coforge-computer.exe" __agent-cli %*\r\n'
    : '#!/bin/sh\nexec "${0%/*}/coforge-computer" __agent-cli "$@"\n';
}

/** The version-local `gh` launcher that runs the adjacent executable's GitHub CLI bridge. */
export function githubCliLauncher(windows: boolean): string {
  return windows
    ? '@echo off\r\n"%~dp0coforge-computer.exe" __agent-cli github gh %*\r\n'
    : '#!/bin/sh\nexec "${0%/*}/coforge-computer" __agent-cli github gh "$@"\n';
}

/** Windows' PATH shim `coforge-computer.cmd`: reads active.json on every run and starts that
 * version's executable, so activation never rewrites it. */
export function windowsComputerLauncher(installRoot: string): string {
  return [
    "@echo off",
    `for /f "usebackq tokens=*" %%i in (\`powershell -NoProfile -Command "(Get-Content -Raw '${win32.join(installRoot, "active.json").replaceAll("'", "''")}' | ConvertFrom-Json).current"\`) do set COFORGE_ACTIVE=%%i`,
    `"${win32.join(installRoot, "versions")}\\%COFORGE_ACTIVE%\\coforge-computer.exe" %*`,
    "",
  ].join("\r\n");
}

export class UpdateError extends Error {
  constructor(
    readonly code:
      | "UPDATE_DOWNLOAD_FAILED"
      | "UPDATE_FEED_INVALID"
      | "UPDATE_INTEGRITY_FAILED"
      | "UPDATE_UNSUPPORTED_TARGET",
    message: string,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface ComputerUpdaterOptions {
  installRoot: string;
}

/** Reads the installed version. Installing is the installer's job (`coforge-installer`), and
 * resolving a version selection is `runInstallationSource` (release/installation-source.ts); this
 * class never writes the installation. */
export class ComputerUpdater {
  readonly #installRoot: string;

  constructor(options: ComputerUpdaterOptions) {
    this.#installRoot = options.installRoot;
  }

  async getCurrentVersion(): Promise<string | null> {
    const active = await this.#readJson<ActiveState>("active.json");
    if (!active) return null;
    this.#assertVersion(active.current, "active version is invalid");
    return active.current;
  }

  #assertVersion(value: string, message: string): void {
    if (!isValidVersion(value)) {
      throw new UpdateError("UPDATE_FEED_INVALID", message);
    }
  }

  async #readJson<T>(relativePath: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.#installRoot, relativePath), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
