import { afterEach, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupInstallerFixtures,
  run,
  serveStub,
  temporaryDirectories,
} from "./installer-script-runner";
import { subprocessTest } from "./subprocess-test";

afterEach(cleanupInstallerFixtures);

subprocessTest(
  "install.sh exits 75 when the feed answers 5xx or cannot be reached, only for the Computer's modes",
  async () => {
    const failing = serveStub({ fetch: () => new Response("down", { status: 500 }) });
    const unreachable = serveStub({ fetch: () => new Response("") });
    const unreachableUrl = `http://127.0.0.1:${unreachable.port}`;
    unreachable.stop(true);
    const directory = await mkdtemp(join(tmpdir(), "coforge-prepare-"));
    temporaryDirectories.push(directory);
    const feeds = [`http://127.0.0.1:${failing.port}`, unreachableUrl];
    for (const feedUrl of feeds) {
      const env = {
        ...process.env,
        COFORGE_RELEASE_FEED_URL: feedUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      };
      for (const args of [
        ["--resolve-only", "--version", "latest", "--target", "linux-x64"],
        ["--prepare-directory", directory, "--version", "3.2.1", "--target", "linux-x64"],
        [
          "--prepare-directory",
          directory,
          "--version",
          "3.2.1",
          "--target",
          "linux-x64",
          "--prepare-phase",
          "installer",
        ],
      ]) {
        expect((await run(args, env)).exitCode).toBe(75);
      }
      // The bootstrap keeps the generic failure status.
      expect((await run(["--version", "latest"], env)).exitCode).toBe(1);
    }
  },
);
