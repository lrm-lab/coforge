import { expect, test } from "bun:test";

import { verifyProductionCandidate } from "./production-candidate";

const COMMIT = "426f3d50f9526bb567e5c04a1d42c9b6875f06c3";
const OTHER_COMMIT = "e830e6373744e46f8c2f5f6ede7d4e306ec94b37";
const STAGING = "https://releases-staging.coforge.cn";

/** A staging feed holding exactly `objects`; every other key answers 404, as the CDN does. */
function stagingFeed(objects: Record<string, string>) {
  const requested: string[] = [];
  const fetch = async (url: string | URL) => {
    const key = String(url).slice(`${STAGING}/`.length);
    requested.push(key);
    const body = objects[key];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  };
  return { fetch, requested };
}

const manifest = (version: string, commit: string) => JSON.stringify({ version, commit });
const cargoToml = (version: string) =>
  `[package]\nname = "coforge-installer"\nversion = "${version}"\n`;

test("a Computer candidate is the stable version staging's latest names, built from the approved commit", async () => {
  const feed = stagingFeed({ latest: "0.1.1\n", "0.1.1/manifest.json": manifest("0.1.1", COMMIT) });
  await verifyProductionCandidate(
    { track: "computer", version: "0.1.1", commit: COMMIT, stagingFeedUrl: STAGING },
    { fetch: feed.fetch },
  );
  expect(feed.requested.sort()).toEqual(["0.1.1/manifest.json", "latest"]);
});

test("a stable Computer release can name a different staging version of the same approved source", async () => {
  const feed = stagingFeed({
    latest: "0.1.3-dev.1\n",
    "0.1.3-dev.1/manifest.json": manifest("0.1.3-dev.1", COMMIT),
    "0.1.2/manifest.json": manifest("0.1.2", OTHER_COMMIT),
  });
  await verifyProductionCandidate(
    {
      track: "computer",
      version: "0.1.2",
      stagingVersion: "0.1.3-dev.1",
      commit: COMMIT,
      stagingFeedUrl: STAGING,
    },
    { fetch: feed.fetch },
  );
  expect(feed.requested.sort()).toEqual(["0.1.3-dev.1/manifest.json", "latest"]);
});

test("a Computer candidate is refused when it is a prerelease, even one staging's latest names", async () => {
  const feed = stagingFeed({
    latest: "0.1.1-dev.10",
    "0.1.1-dev.10/manifest.json": manifest("0.1.1-dev.10", COMMIT),
  });
  await expect(
    verifyProductionCandidate(
      { track: "computer", version: "0.1.1-dev.10", commit: COMMIT, stagingFeedUrl: STAGING },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/stable/);
});

test("a Computer candidate is refused when staging's latest has moved to another version", async () => {
  const feed = stagingFeed({ latest: "0.1.2", "0.1.1/manifest.json": manifest("0.1.1", COMMIT) });
  await expect(
    verifyProductionCandidate(
      { track: "computer", version: "0.1.1", commit: COMMIT, stagingFeedUrl: STAGING },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/staging latest is 0\.1\.2/);
});

test("a candidate is refused when staging published that version from another commit", async () => {
  const feed = stagingFeed({
    latest: "0.1.1",
    "0.1.1/manifest.json": manifest("0.1.1", OTHER_COMMIT),
  });
  await expect(
    verifyProductionCandidate(
      { track: "computer", version: "0.1.1", commit: COMMIT, stagingFeedUrl: STAGING },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(new RegExp(OTHER_COMMIT));
});

test("a candidate is refused when staging never published that version", async () => {
  const feed = stagingFeed({ latest: "0.1.1" });
  await expect(
    verifyProductionCandidate(
      { track: "computer", version: "0.1.1", commit: COMMIT, stagingFeedUrl: STAGING },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/0\.1\.1\/manifest\.json.*404/);
});

test("a candidate names a full commit, never a branch or an abbreviation", async () => {
  const feed = stagingFeed({});
  for (const commit of ["main", COMMIT.slice(0, 12), COMMIT.toUpperCase()]) {
    await expect(
      verifyProductionCandidate(
        { track: "computer", version: "0.1.1", commit, stagingFeedUrl: STAGING },
        { fetch: feed.fetch },
      ),
    ).rejects.toThrow(/40 lowercase hex/);
  }
  expect(feed.requested).toEqual([]);
});

test("an installer candidate is the crate's version at the approved commit, published to staging from it", async () => {
  const feed = stagingFeed({ "installer/0.1.3/manifest.json": manifest("0.1.3", COMMIT) });
  await verifyProductionCandidate(
    {
      track: "installer",
      version: "0.1.3",
      commit: COMMIT,
      stagingFeedUrl: STAGING,
      cargoToml: cargoToml("0.1.3"),
    },
    { fetch: feed.fetch },
  );
  // The installer's pointer moves on its own (rollback by `pointer_only`), so it is not compared.
  expect(feed.requested).toEqual(["installer/0.1.3/manifest.json"]);
});

test("an installer candidate is refused when the approved commit's crate has another version", async () => {
  const feed = stagingFeed({ "installer/0.1.3/manifest.json": manifest("0.1.3", COMMIT) });
  await expect(
    verifyProductionCandidate(
      {
        track: "installer",
        version: "0.1.3",
        commit: COMMIT,
        stagingFeedUrl: STAGING,
        cargoToml: cargoToml("0.1.4"),
      },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/Cargo\.toml.*0\.1\.4/);
});

test("without staging evidence a candidate is checked for shape alone and the staging feed is never read", async () => {
  const feed = stagingFeed({});
  await verifyProductionCandidate(
    {
      track: "computer",
      version: "0.1.0",
      commit: COMMIT,
      stagingFeedUrl: STAGING,
      withoutStaging: true,
    },
    { fetch: feed.fetch },
  );
  await verifyProductionCandidate(
    {
      track: "installer",
      version: "0.1.3",
      commit: COMMIT,
      stagingFeedUrl: STAGING,
      cargoToml: cargoToml("0.1.3"),
      withoutStaging: true,
    },
    { fetch: feed.fetch },
  );
  expect(feed.requested).toEqual([]);
  for (const candidate of [
    { version: "0.1.1-dev.10", commit: COMMIT },
    { version: "0.1.0", commit: "main" },
  ]) {
    await expect(
      verifyProductionCandidate(
        { track: "computer", stagingFeedUrl: STAGING, withoutStaging: true, ...candidate },
        { fetch: feed.fetch },
      ),
    ).rejects.toThrow(/stable|40 lowercase hex/);
  }
  await expect(
    verifyProductionCandidate(
      {
        track: "installer",
        version: "0.1.3",
        commit: COMMIT,
        stagingFeedUrl: STAGING,
        cargoToml: cargoToml("0.1.4"),
        withoutStaging: true,
      },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/Cargo\.toml.*0\.1\.4/);
});

test("naming staging evidence cannot be combined with skipping that evidence", async () => {
  const feed = stagingFeed({});
  await expect(
    verifyProductionCandidate(
      {
        track: "computer",
        version: "0.1.2",
        stagingVersion: "0.1.3-dev.1",
        commit: COMMIT,
        stagingFeedUrl: STAGING,
        withoutStaging: true,
      },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/cannot combine/);
});

test("the separate staging version is only supported for Computer candidates", async () => {
  const feed = stagingFeed({ "installer/0.1.1/manifest.json": manifest("0.1.1", COMMIT) });
  await expect(
    verifyProductionCandidate(
      {
        track: "installer",
        version: "0.1.1",
        stagingVersion: "0.1.1",
        commit: COMMIT,
        stagingFeedUrl: STAGING,
        cargoToml: cargoToml("0.1.1"),
      },
      { fetch: feed.fetch },
    ),
  ).rejects.toThrow(/only supported for Computer/);
});

test("the production CLI validates the explicitly named staging version against its source", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/latest") return new Response("0.1.3-dev.1\n");
      if (path === "/0.1.3-dev.1/manifest.json") {
        return new Response(manifest("0.1.3-dev.1", COMMIT));
      }
      return new Response("missing", { status: 404 });
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/production-candidate.ts`,
        "computer",
        "0.1.2",
        COMMIT,
        server.url.toString(),
        "--staging-version=0.1.3-dev.1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain(`staging published computer 0.1.3-dev.1 from ${COMMIT}`);
    expect(stdout).toContain("production version 0.1.2");
  } finally {
    child?.kill();
    server.stop(true);
  }
});
