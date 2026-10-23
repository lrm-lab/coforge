import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { obtainInstaller } from "#src/release/installer-launch";

import {
  failureOf,
  isolateProxyEnvironment,
  startFeed as startFixtureFeed,
} from "./installer-feed-fixture";

/** A download failure of the install script is retried; any other failure is not. */

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

function startFeed() {
  return startFixtureFeed(servers);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coforge-installer-launch-"));
  temporaryDirectories.push(path);
  return path;
}

async function obtain(feedUrl: string, target: string, installRoot: string) {
  return obtainInstaller({ feedUrl, target, installRoot, retryDelaysMs: noDelays });
}

test("a missing installer/latest pointer is a download failure, tried three times in all", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0", undefined, false);

  const failure = await failureOf(obtain(feed.url, feed.target, installRoot));

  expect(failure.code).toBe("UPDATE_DOWNLOAD_FAILED");
  expect(failure.message).toContain("exit 75");
  expect(feed.requested).toEqual(Array(3).fill("/installer/latest"));
  expect(await readdir(installRoot)).toEqual([]);
});

test("a missing manifest is a download failure, tried three times in all", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0");
  feed.route("0.1.0/manifest.json", () => new Response("gone", { status: 404 }));

  const failure = await failureOf(obtain(feed.url, feed.target, installRoot));

  expect(failure.code).toBe("UPDATE_DOWNLOAD_FAILED");
  expect(feed.requested).toEqual([
    "/installer/latest",
    ...Array(3).fill("/installer/0.1.0/manifest.json"),
  ]);
  expect(await readdir(installRoot)).toEqual([]);
});

test("a download that fails once is retried and the upgrade carries on", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0");
  let served = 0;
  feed.route("latest", () =>
    ++served === 1 ? new Response("unavailable", { status: 503 }) : new Response("0.1.0\n"),
  );

  const installer = await obtain(feed.url, feed.target, installRoot);

  expect(installer.version).toBe("0.1.0");
  expect(feed.requested.filter((path) => path === "/installer/latest")).toHaveLength(2);
});

test("an unreachable feed is a download failure", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const unreachable = feed.url;
  servers.splice(0).forEach((server) => server.stop(true));

  const failure = await failureOf(obtain(unreachable, feed.target, installRoot));

  expect(failure.code).toBe("UPDATE_DOWNLOAD_FAILED");
});

test("a pointer that is not a version is a feed failure and is not retried", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.point("../evil");

  const failure = await failureOf(obtain(feed.url, feed.target, installRoot));

  expect(failure.code).toBe("UPDATE_FEED_INVALID");
  expect(feed.requested).toEqual(["/installer/latest"]);
});
