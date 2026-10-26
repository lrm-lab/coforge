import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { cleanupInstallerFixtures, run } from "./installer-script-runner";

/** Processes whose command line names this feed: the script's shell and the curl it started. */
async function processesUsing(feedUrl: string): Promise<string> {
  const pgrep = Bun.spawn(["pgrep", "-f", feedUrl], { stdout: "pipe" });
  const [out] = await Promise.all([new Response(pgrep.stdout).text(), pgrep.exited]);
  return out.trim();
}

test("cleanup reaps a script and the processes it started before it removes the script's directories", async () => {
  let requested!: () => void;
  const reachedFeed = new Promise<void>((resolve) => {
    requested = resolve;
  });
  // A listener the fixtures do not own, which accepts and never answers: stopping the fixture feed
  // would reset curl's connection and let it exit by itself, hiding a cleanup that left it behind.
  const feed = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open: () => requested(), data() {} },
  });
  const feedUrl = `http://127.0.0.1:${feed.port}`;
  const running = run(["install"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: feedUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  await reachedFeed;
  // curl is a grandchild of the test, blocked on the feed: it is what must not outlive the cleanup.
  expect(await processesUsing(feedUrl)).not.toBe("");

  await cleanupInstallerFixtures();

  const result = await running;
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(result.home)).toBe(false);
  feed.stop(true);
  expect(await processesUsing(feedUrl)).toBe("");
});
