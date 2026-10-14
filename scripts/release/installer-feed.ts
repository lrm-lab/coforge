/**
 * Where `coforge-installer` lives in the release feed, and what the product's release has to know
 * about it. docs/release/installer-feed.md is the contract; this module is its keys.
 *
 * The installer shares the product's bucket and has a prefix of its own: `installer/latest` (the
 * feed's second mutable object), and one write-once `installer/<version>/` per installer release.
 * Its version comes from the crate, not from the product's release line, so the two move
 * independently.
 */
import { InstallerManifestSchema } from "@coforge/computer/src/release/installer-contract";

import { isValidReleaseVersion } from "./build-release";
import type { FeedLayout } from "./publish";

export const INSTALLER_LATEST_KEY = "installer/latest";

/** `installer/<version>/manifest.json`: the completion marker of an installer version. */
export function installerManifestKey(version: string): string {
  return `installer/${version}/manifest.json`;
}

/** An object beneath `installer/<version>/`, by its path there (`<target>/coforge-installer.gz`). */
export function installerObjectKey(version: string, path: string): string {
  return `installer/${version}/${path}`;
}

/** The installer feed as the shared upload flow (`publish.ts`) addresses it. */
export const INSTALLER_FEED: FeedLayout = {
  latestKey: INSTALLER_LATEST_KEY,
  manifestKey: installerManifestKey,
};

/**
 * The installer version a checkout would publish: `crates/installer/Cargo.toml`'s `version`. The
 * crate is the single owner of its version; the workflow takes no version input.
 */
export function installerVersionFromCargoToml(cargoToml: string): string {
  const manifest = Bun.TOML.parse(cargoToml) as { package?: { version?: unknown } };
  const version = manifest.package?.version;
  if (typeof version !== "string" || !isValidReleaseVersion(version)) {
    throw new Error(
      `crates/installer/Cargo.toml has no valid [package] version to publish: ${String(version)}`,
    );
  }
  return version;
}

export type InstallerManifest = ReturnType<typeof InstallerManifestSchema.parse>;

/**
 * An installer manifest as the product's own schema reads it, or undefined when the bytes are not
 * one. The feed is read by clients that trust it, so a pointer is only ever aimed at a version
 * whose manifest this accepts.
 */
export function parseInstallerManifest(bytes: Uint8Array): InstallerManifest | undefined {
  try {
    const parsed = InstallerManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The workflow that publishes an installer or moves its pointer. */
const INSTALLER_WORKFLOW = "gh workflow run release-installer-staging.yml --repo lrm-lab/coforge";

/**
 * The installer protocol a product release says it needs (`installer_protocol` in its schema 2
 * manifest), or undefined when it says nothing. A field that is present but not a positive integer
 * is an error, never "nothing": a release must not slip past the gate on a typo.
 */
export function productInstallerProtocol(manifestBytes: Uint8Array): number | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("the product release manifest is not JSON");
  }
  const value = (manifest as { installer_protocol?: unknown } | null)?.installer_protocol;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `the product release manifest's installer_protocol must be a positive integer: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The gate a product release passes before its own `latest` moves: the installer that
 * `installer/latest` names must speak at least the protocol the release needs, or a machine that
 * upgrades to it would fetch an installer that cannot install it. Resolves with the line to log;
 * rejects with what to run to fix it. The feed is read through `readObject` (undefined when an
 * object is absent) so the rule stays independent of how the bucket is reached.
 */
export async function assertInstallerCoversRelease(input: {
  releaseVersion: string;
  requiredProtocol: number | undefined;
  readObject: (key: string) => Promise<Uint8Array | undefined>;
}): Promise<string> {
  const { releaseVersion, requiredProtocol, readObject } = input;
  if (requiredProtocol === undefined) {
    return `installer gate: release ${releaseVersion} declares no installer_protocol, so no installer is required`;
  }
  const need = `release ${releaseVersion} needs installer protocol ${requiredProtocol}`;
  const repair = `Move it to a good installer: ${INSTALLER_WORKFLOW} -f pointer_only=<installer version>. `;

  const pointer = await readObject(INSTALLER_LATEST_KEY);
  if (!pointer) {
    throw new Error(
      `${need}, but no installer is published (${INSTALLER_LATEST_KEY} is absent). ` +
        `Publish one first: ${INSTALLER_WORKFLOW}`,
    );
  }
  const version = new TextDecoder().decode(pointer).trim();
  if (!isValidReleaseVersion(version)) {
    throw new Error(
      `${need}, but ${INSTALLER_LATEST_KEY} does not name a version (${JSON.stringify(version)}). ${repair}`,
    );
  }
  const bytes = await readObject(installerManifestKey(version));
  const manifest = bytes && parseInstallerManifest(bytes);
  if (!manifest || manifest.version !== version) {
    throw new Error(
      `${need}, but ${INSTALLER_LATEST_KEY} names ${version}, whose manifest is missing or invalid. ${repair}`,
    );
  }
  if (manifest.installer_protocol < requiredProtocol) {
    throw new Error(
      `${need}, but ${INSTALLER_LATEST_KEY} (${version}) speaks protocol ${manifest.installer_protocol}. ` +
        `Publish an installer that speaks it (raise "version" in crates/installer/Cargo.toml, then ` +
        `${INSTALLER_WORKFLOW}), or, if one is already published, point at it: ` +
        `${INSTALLER_WORKFLOW} -f pointer_only=<installer version>`,
    );
  }
  return `installer gate: ${need}; ${INSTALLER_LATEST_KEY} is ${version} (protocol ${manifest.installer_protocol})`;
}
