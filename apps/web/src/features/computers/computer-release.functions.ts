import { createServerFn } from "@tanstack/react-start";
import { COMPUTER_RELEASE_APP } from "@lrm/coforge-sdk/internal";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readLatestComputerVersion } from "#src/server/computers/latest-computer-version.server";
import { resolveReleaseFeedUrl } from "#src/server/install/install-script.server";
import { productionReleaseCatalog } from "#src/server/release-catalog/release-catalog-production.server";
import {
  parseServerReleaseChannel,
  releaseFeedForChannel,
} from "#src/server/computers/release-channel.server";
import {
  computerReleaseNotesInputSchema,
  latestComputerVersionInputSchema,
} from "./computer.schemas";

export const getLatestComputerVersion = createServerFn({ method: "GET" })
  .validator(latestComputerVersionInputSchema)
  .handler(async ({ data }) => {
    const channel = parseServerReleaseChannel(data.channel);
    if (channel?.startsWith("pinned:")) return channel.slice("pinned:".length);
    const feedUrl = channel ? releaseFeedForChannel(channel) : resolveReleaseFeedUrl();
    if (!feedUrl) return null;
    return readLatestComputerVersion(feedUrl);
  });

/** One Computer release's notes from the release catalog, or `null` when it has none. */
export const getComputerReleaseNotes = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(computerReleaseNotesInputSchema)
  .handler(async ({ data }) => {
    const release = await productionReleaseCatalog().getReleaseNotes(
      COMPUTER_RELEASE_APP,
      data.version,
    );
    return release ? { version: release.version, notes: release.notes } : null;
  });
