import { isValidReleaseVersion } from "@lrm/coforge-sdk/internal";
import { resolveReleaseFeedUrl } from "#src/server/install/install-script.server";
import type { ServerReleaseChannel } from "./computer-release-state.server";

const STAGING_FEED_URL = "https://releases-staging.coforge.cn";

export function parseServerReleaseChannel(
  raw: string | undefined,
): ServerReleaseChannel | undefined {
  const value = raw?.trim();
  if (!value || value === "latest" || value === "alpha")
    return value as ServerReleaseChannel | undefined;
  if (!value.startsWith("pinned:")) return undefined;
  const version = value.slice("pinned:".length);
  return isValidReleaseVersion(version) ? `pinned:${version}` : undefined;
}

/** Resolves the server's allowlisted feed for one persisted selector. Named channels fail closed. */
export function releaseFeedForChannel(channel: ServerReleaseChannel): string | undefined {
  const productionFeed = resolveReleaseFeedUrl();
  if (channel === "alpha") return STAGING_FEED_URL;
  if (channel === "latest" || channel.startsWith("pinned:")) return productionFeed ?? undefined;
  return undefined;
}
