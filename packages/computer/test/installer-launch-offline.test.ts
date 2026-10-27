import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { obtainInstaller } from "#src/release/installer-launch";

import {
  failureOf,
  isolateProxyEnvironment,
  sha256hex,
  startFeed as startFixtureFeed,
} from "./installer-feed-fixture";

/** With the feed unreachable, the installer last used and still intact is the one that runs. */

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

isolateProxyEnvironment();

const noDelays = [0, 0] as const;

async function installRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coforge-installer-offline-"));
  temporaryDirectories.push(path);
  return path;
}

/** Fetches `version` into `root` and returns the cached copy's path. */
async function seed(root: string, version: string): Promise<string> {
  const feed = startFixtureFeed(servers);
  feed.publish(version);
  const installer = await obtainInstaller({
    feedUrl: feed.url,
    target: feed.target,
    installRoot: root,
    retryDelaysMs: noDelays,
  });
  return installer.path;
}

/** A feed that answers nothing: `installer/latest` is a 404, which is a download failure. */
function offline(root: string) {
  const feed = startFixtureFeed(servers);
  return {
    feed,
    obtain: () =>
      obtainInstaller({
        feedUrl: feed.url,
        target: feed.target,
        installRoot: root,
        retryDelaysMs: noDelays,
      }),
  };
}

test("an unreachable feed falls back to the cached installer, hashed again, and notes it was used", async () => {
  const root = await installRoot();
  const cached = await seed(root, "0.1.0");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(cached, old, old);

  const installer = await offline(root).obtain();

  expect(installer.path).toBe(cached);
  expect(installer.version).toBeUndefined();
  expect((await Bun.file(cached).stat()).mtimeMs).toBeGreaterThan(old.getTime() + 1_000_000);
});

test("a manifest that cannot be fetched falls back the same way", async () => {
  const root = await installRoot();
  const cached = await seed(root, "0.1.0");
  const feed = startFixtureFeed(servers);
  feed.publish("0.2.0");
  feed.route("0.2.0/manifest.json", () => new Response("gone", { status: 404 }));

  const installer = await obtainInstaller({
    feedUrl: feed.url,
    target: feed.target,
    installRoot: root,
    retryDelaysMs: noDelays,
  });

  expect(installer.path).toBe(cached);
});

test("the most recently used intact copy wins over a newer-looking damaged one", async () => {
  const root = await installRoot();
  const first = await seed(root, "0.1.0");
  const second = await seed(root, "0.2.0");
  const third = await seed(root, "0.3.0");
  const now = Date.now();
  await utimes(first, new Date(now - 3_000_000), new Date(now - 3_000_000));
  await utimes(second, new Date(now - 2_000_000), new Date(now - 2_000_000));
  await utimes(third, new Date(now - 1_000_000), new Date(now - 1_000_000));
  await writeFile(third, "tampered");

  const installer = await offline(root).obtain();

  expect(installer.path).toBe(second);
});

test("a copy whose bytes no longer match its checksum directory is not trusted", async () => {
  const root = await installRoot();
  const cached = await seed(root, "0.1.0");
  await writeFile(cached, "#!/bin/sh\nexit 0\n# tampered\n");
  expect(sha256hex(Buffer.from(await Bun.file(cached).arrayBuffer()))).not.toBe(
    cached.split("/").at(-2)!,
  );

  const failure = await failureOf(offline(root).obtain());

  expect(failure.code).toBe("UPDATE_DOWNLOAD_FAILED");
});

test("with nothing cached the original download failure is thrown", async () => {
  const root = await installRoot();

  const failure = await failureOf(offline(root).obtain());

  expect(failure.code).toBe("UPDATE_DOWNLOAD_FAILED");
});

test("only a download failure falls back: a feed answering nonsense is still an invalid feed", async () => {
  const root = await installRoot();
  await seed(root, "0.1.0");
  const feed = startFixtureFeed(servers);
  feed.point("latest\n");

  const failure = await failureOf(
    obtainInstaller({
      feedUrl: feed.url,
      target: feed.target,
      installRoot: root,
      retryDelaysMs: noDelays,
    }),
  );

  expect(failure.code).toBe("UPDATE_FEED_INVALID");
});
