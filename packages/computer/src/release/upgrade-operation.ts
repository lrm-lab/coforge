import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { assertOfficialReleaseFeedUrl, resolveReleaseFeedForChannel } from "#src/release-channel";
import { parseReleaseChannel, type ReleaseChannel } from "#src/release/channel-state";

/** Who asked for the operation. Remote operations owe the server a terminal result. */
export type UpgradeOperationOrigin = "remote" | "cli";

/**
 * One Computer upgrade, identified once at the process boundary and carried explicitly from there:
 * the CLI and the `__remote-upgrade` entry point both build the same record, and it reaches the
 * installer as `--request-id`, never through the environment.
 */
export type UpgradeOperation = {
  /** Stable operation identity; also names the receipt file. */
  requestId: string;
  /** The release selector, or "latest". */
  selection: string;
  origin: UpgradeOperationOrigin;
  /**
   * Lets the installer activate a version older than the installed one. Set only by the CLI
   * boundary (`createLocalUpgradeOperation`); a remote operation never carries it.
   */
  allowDowngrade?: boolean;
  /** Official feed selected by an interactive channel choice; absent for server-triggered latest. */
  releaseFeedUrl?: string;
  /** Channel forwarded by the server; the Computer resolves it to its official feed. */
  releaseChannel?: ReleaseChannel;
};

export function assertUpgradeRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !RFC_UUID_PATTERN.test(value))
    throw new Error("upgrade operation requires a valid UUID request ID");
}

/** Builds the operation a server-triggered upgrade runs, from `__remote-upgrade` arguments. */
export function parseRemoteUpgradeOperation(argv: readonly string[]): UpgradeOperation {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const requestId = value("--request-id");
  assertUpgradeRequestId(requestId);
  const selection = value("--version");
  if (!selection) throw new Error("remote upgrade requires --version");
  const releaseFeedFlag = argv.indexOf("--release-feed");
  const rawReleaseFeedUrl = value("--release-feed");
  if (releaseFeedFlag >= 0 && !rawReleaseFeedUrl)
    throw new Error("remote upgrade --release-feed requires a value");
  const channelFlag = argv.indexOf("--channel");
  const rawChannel = value("--channel");
  if (channelFlag >= 0 && !rawChannel) throw new Error("remote upgrade --channel requires a value");
  const releaseChannel = rawChannel ? parseReleaseChannel(rawChannel) : null;
  if (rawChannel && !releaseChannel)
    throw new Error(`invalid remote upgrade channel "${rawChannel}"`);
  if (rawReleaseFeedUrl && releaseChannel)
    throw new Error("remote upgrade cannot combine --release-feed and --channel");
  const releaseFeedUrl = rawReleaseFeedUrl
    ? assertOfficialReleaseFeedUrl(rawReleaseFeedUrl)
    : releaseChannel
      ? resolveReleaseFeedForChannel(releaseChannel)
      : undefined;
  return {
    requestId,
    selection,
    origin: "remote",
    ...(releaseFeedUrl ? { releaseFeedUrl } : {}),
    ...(releaseChannel ? { releaseChannel } : {}),
  };
}

/** Builds the operation an interactive `upgrade` or `install` command runs. */
export function createLocalUpgradeOperation(
  selection: string,
  options: { allowDowngrade: boolean; releaseFeedUrl?: string },
): UpgradeOperation {
  return {
    requestId: crypto.randomUUID(),
    selection,
    origin: "cli",
    allowDowngrade: options.allowDowngrade,
    releaseFeedUrl: options.releaseFeedUrl,
  };
}
