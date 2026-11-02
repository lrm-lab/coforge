// The Computer's local build (`bun run build`): this host's executable, built exactly as a
// release target is, with this package's version and the feed from COFORGE_RELEASE_FEED_URL.
import { join } from "node:path";

import { resolveReleaseFeedUrl } from "#src/release-channel";
import { buildComputerExecutable } from "./build-executable";

const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();

await buildComputerExecutable({
  version: manifest.version,
  feedUrl: resolveReleaseFeedUrl(Bun.env.COFORGE_RELEASE_FEED_URL),
  outfile: join(import.meta.dir, "../dist/coforge-computer"),
});
