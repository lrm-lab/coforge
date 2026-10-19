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

export function operatingSystemLabel(computer: ComputerPlatformInfo): string {
  const name =
    computer.platform === "darwin"
      ? "macOS"
      : computer.platform === "linux"
        ? "Linux"
        : computer.platform === "win32"
          ? "Windows"
          : undefined;
  return name
    ? `${name} ${computer.osVersion || m.computer_metadata_unknown()}`
    : m.computer_metadata_unknown();
}

/** What a Computer's CoForge version reads as. The list row and the detail panel both show it, so it
 * is stated here rather than twice; a Computer that has never reported one reads as an em dash in the
 * panel, while the list row omits the version entirely rather than repeat that in every row. */
export function computerVersionLabel(computer: { computerVersion?: string | null }): string {
  return computer.computerVersion || "—";
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
 * The release its owner is offered for a Computer, in full, or none: a cloud Computer's newer
 * image, or for a local one the latest release when it is newer than the running one. Only the
 * owner can upgrade, so nobody else is offered one (features/computers/AGENTS.md).
 */
export function offeredUpdateVersion(
  computer: {
    kind: string;
    ownedByCurrentUser: boolean;
    computerVersion?: string | null;
    imageUpdate?: { version: string } | null;
  },
  latestComputerVersion: string | null | undefined,
): string | undefined {
  if (!computer.ownedByCurrentUser) return undefined;
  if (computerKind(computer.kind) === "cloud") return computer.imageUpdate?.version;
  return isComputerUpdateAvailable(computer.computerVersion, latestComputerVersion)
    ? (latestComputerVersion ?? undefined)
    : undefined;
}
