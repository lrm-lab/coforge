import { join, resolve } from "node:path";

import { resolveReleaseFeedUrl, resolveServerUrl } from "@coforge/computer/src/release-channel";
import { zodResolvePlugin } from "../bun-resolve-zod-plugin";

// The Daemon package's build. The Computer builds itself (packages/computer/scripts/build.ts).
const REPO_ROOT = resolve(import.meta.dir, "../..");

if (Bun.argv[2] !== "daemon") {
  throw new Error("usage: bun scripts/release/build-package.ts daemon");
}

const feedUrl = resolveReleaseFeedUrl(Bun.env.COFORGE_RELEASE_FEED_URL);
const packageDirectory = join(REPO_ROOT, "packages/daemon");
const manifest = await Bun.file(join(packageDirectory, "package.json")).json();

const result = await Bun.build({
  entrypoints: [join(packageDirectory, "index.ts")],
  target: "bun",
  outdir: join(packageDirectory, "dist"),
  define: {
    "process.env.COFORGE_DAEMON_VERSION": JSON.stringify(manifest.version),
    "process.env.COFORGE_DAEMON_SERVER_URL": JSON.stringify(resolveServerUrl(feedUrl)),
  },
  plugins: [zodResolvePlugin(REPO_ROOT)],
});

if (!result.success) {
  throw new Error(result.logs.map(String).join("; "));
}
