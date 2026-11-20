import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { compareReleaseVersions, parseReleaseVersion } from "@lrm/coforge-sdk/internal";

/**
 * How the Web names and pictures one Computer.
 *
 * `displayName` is the human-facing identity and `name` is its system hostname.
 * `kind` says whether it runs locally or in CoForge's
 * cloud; machine identity never participates in display or selection.
 */
export type ComputerKind = "local" | "cloud";

export type ComputerIdentity = {
  kind: string;
  name: string;
  displayName: string;
};

export function computerKind(kind: string): ComputerKind {
  return kind === "cloud" ? "cloud" : "local";
}

export function computerLabel(computer: ComputerIdentity): string {
  return (
    computer.displayName.trim() ||
    computer.name.trim() ||
    (computerKind(computer.kind) === "cloud"
      ? m.computer_cloud_computer()
      : m.computer_platform_unknown())
  );
}

export function computerIcon(computer: ComputerIdentity): typeof Cloud | typeof Monitor {
  if (computerKind(computer.kind) === "cloud") return Cloud;
  return Monitor;
}

/** What the Computer's daemon last reported about its host machine. */
export type ComputerPlatformInfo = {
  platform?: string | null;
  osVersion?: string | null;
};

/** The system the Computer runs ("macOS 15.1", or "Linux" without a reported version); null for a
 * system it has not reported, which callers leave out rather than write as "Unknown". */
export function operatingSystemLabel(computer: ComputerPlatformInfo): string | null {
  const name =
    computer.platform === "darwin"
      ? "macOS"
      : computer.platform === "linux"
        ? "Linux"
        : computer.platform === "win32"
          ? "Windows"
          : undefined;
  if (!name) return null;
  return computer.osVersion ? `${name} ${computer.osVersion}` : name;
}

/** Compare the numeric portions of release versions without treating an unknown format as newer. */
export function isComputerUpdateAvailable(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): boolean {
  if (
    !currentVersion ||
    !latestVersion ||
    !parseReleaseVersion(currentVersion) ||
    !parseReleaseVersion(latestVersion)
  )
    return false;

  return compareReleaseVersions(latestVersion!, currentVersion!) > 0;
}

/** A release with a semver pre-release suffix (`0.1.4-dev.2`), which the panel labels as such. */
export function isPrereleaseVersion(version: string | null | undefined): boolean {
  return Boolean(version && parseReleaseVersion(version)?.prerelease.length);
}

/**
 * The runtime release a Computer could install, or none. A cloud Computer uses the same
 * comparison against the release feed. A newer node image is a separate offer.
 */
export function availableUpdateVersion(
  computer: {
    kind: string;
    computerVersion?: string | null;
  },
  latestComputerVersion: string | null | undefined,
): string | undefined {
  return isComputerUpdateAvailable(computer.computerVersion, latestComputerVersion)
    ? (latestComputerVersion ?? undefined)
    : undefined;
}

export function computerListUpdateVersion(
  computer: {
    kind: string;
    ownedByCurrentUser: boolean;
    computerVersion?: string | null;
    imageUpdate?: { version: string } | null;
  },
  latestComputerVersion: string | null | undefined,
): string | undefined {
  if (!computer.ownedByCurrentUser) return undefined;
  const runtime = availableUpdateVersion(computer, latestComputerVersion);
  if (runtime) return runtime;
  if (computerKind(computer.kind) === "cloud") return computer.imageUpdate?.version || undefined;
  return undefined;
}
