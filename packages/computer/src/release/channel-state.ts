import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isValidReleaseVersion } from "@lrm/coforge-sdk/internal";

export const DEFAULT_RELEASE_CHANNEL = "latest" as const;
export const RELEASE_CHANNEL_FILE = "release-channel";

const NAMED_CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u;
const RESERVED_CHANNELS = new Set([
  "main",
  "stable",
  "rc",
  "release",
  "staging",
  "production",
  "prod",
  "nightly",
  "preview",
  "pinned",
  "default",
]);

export type ReleaseChannel = "latest" | "alpha" | `pinned:${string}` | (string & {});

/** Parse the same selector vocabulary as Raft's persisted channel state. */
export function parseReleaseChannel(raw: string): ReleaseChannel | null {
  const value = raw.trim();
  if (value === "latest" || value === "alpha") return value;
  if (value.startsWith("pinned:")) {
    const version = value.slice("pinned:".length);
    return isValidReleaseVersion(version) ? `pinned:${version}` : null;
  }
  if (
    NAMED_CHANNEL_PATTERN.test(value) &&
    !RESERVED_CHANNELS.has(value) &&
    value !== "latest" &&
    value !== "alpha"
  )
    return value;
  return null;
}

export function releaseChannelPath(stateDirectory: string): string {
  return join(stateDirectory, RELEASE_CHANNEL_FILE);
}

/** A corrupt or missing selector is treated as the safe production default. */
export async function readReleaseChannel(stateDirectory: string): Promise<ReleaseChannel> {
  try {
    const parsed = parseReleaseChannel(await readFile(releaseChannelPath(stateDirectory), "utf8"));
    return parsed ?? DEFAULT_RELEASE_CHANNEL;
  } catch {
    return DEFAULT_RELEASE_CHANNEL;
  }
}

/** Persist with a same-directory replace so a killed process never leaves a partial selector. */
export async function writeReleaseChannel(
  stateDirectory: string,
  channel: ReleaseChannel,
): Promise<void> {
  if (parseReleaseChannel(channel) !== channel)
    throw new Error(`invalid release channel: ${channel}`);
  await mkdir(dirname(releaseChannelPath(stateDirectory)), { recursive: true, mode: 0o700 });
  const path = releaseChannelPath(stateDirectory);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${channel}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
