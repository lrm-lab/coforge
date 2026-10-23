import { afterEach, expect, mock, test } from "bun:test";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configure, reset } from "@logtape/logtape";

import {
  failureOf,
  type InstallerManifest,
  isolateProxyEnvironment,
  sha256hex,
  startFeed as startFixtureFeed,
} from "./installer-feed-fixture";
import { obtainInstaller } from "#src/release/installer-launch";
import { UpdateError } from "#src/updater";

/*
 * `obtainInstaller` is tested through its one public function against a real `Bun.serve` on
 * 127.0.0.1 that plays the release feed's `installer/` tree. The module downloads through the
 * embedded install script, exactly as it does in production, so these tests exercise the script
 * too; only the feed and the install root are substituted.
 */

const { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes } = fileSystem;

/*
 * Three failures and one interleaving that the real file system cannot be made to produce on
 * demand are injected at its boundary, each only while armed; every other call, and every call
 * while nothing is armed, goes to the real file system.
 *  - `refusedRename`: Windows cannot replace an executable that a racing run has already
 *    started, and fails the `rename` with EPERM.
 *  - `refusedPartialRemoval`: removing a run's partial file fails.
 *  - `undeletableCopies`: removing a cached installer copy fails, as it does for a copy still in
 *    use on Windows.
 *  - `beforePartialOpened`: runs once, just before a run creates its partial file, so another
 *    run can finish (and prune) at exactly that moment.
 */
const realFileSystem = { ...fileSystem };
let refusedRename: NodeJS.ErrnoException | undefined;
let refusedPartialRemoval: NodeJS.ErrnoException | undefined;
const undeletableCopies = new Set<string>();
let beforePartialOpened: (() => Promise<void>) | undefined;
mock.module("node:fs/promises", () => ({
  ...realFileSystem,
  rename: (from: string, to: string) =>
    refusedRename ? Promise.reject(refusedRename) : realFileSystem.rename(from, to),
  rm: (path: string, options?: Parameters<typeof realFileSystem.rm>[1]) => {
    if (refusedPartialRemoval && path.includes(".download-")) {
      return Promise.reject(refusedPartialRemoval);
    }
    if (undeletableCopies.has(path)) {
      return Promise.reject(permissionDenied());
    }
    return realFileSystem.rm(path, options);
  },
  open: async (...args: Parameters<typeof realFileSystem.open>) => {
    if (String(args[0]).includes(".download-") && beforePartialOpened) {
      const interleave = beforePartialOpened;
      beforePartialOpened = undefined;
      await interleave();
    }
    return realFileSystem.open(...args);
  },
}));

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  refusedRename = undefined;
  refusedPartialRemoval = undefined;
  undeletableCopies.clear();
  beforePartialOpened = undefined;
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

isolateProxyEnvironment();

function startFeed(target?: string) {
  return startFixtureFeed(servers, target);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coforge-installer-launch-"));
  temporaryDirectories.push(path);
  return path;
}

test("fetches the latest installer, verifies it, and keeps it under the install root", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");

  const installer = await obtainInstaller({
    feedUrl: feed.url,
    target: feed.target,
    installRoot,
  });

  expect(installer.version).toBe("0.1.0");
  expect(installer.path).toBe(
    join(installRoot, "installer", sha256hex(published.binary), "coforge-installer"),
  );
  expect(Buffer.from(await Bun.file(installer.path).arrayBuffer())).toEqual(published.binary);
  expect(feed.requested).toEqual([
    "/installer/latest",
    "/installer/0.1.0/manifest.json",
    "/installer/0.1.0/linux-x64/coforge-installer.gz",
  ]);
  if (process.platform !== "win32") {
    expect((await stat(installer.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(installer.path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(join(installer.path, "..", ".."))).mode & 0o777).toBe(0o700);
  }
});

test("resolves a pointer padded with whitespace from a feed URL with a trailing slash", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0", undefined, false);
  feed.point(" \r\n0.1.0 \n\n");

  const installer = await obtainInstaller({
    feedUrl: `${feed.url}/`,
    target: feed.target,
    installRoot,
  });

  expect(installer.version).toBe("0.1.0");
});

for (const pointer of ["latest", "latest\n", "", "  \n", "../evil", "-flag", "1..2", "a/b"]) {
  test(`an installer/latest pointer of ${JSON.stringify(pointer)} is refused before any download`, async () => {
    const installRoot = await temporaryDirectory();
    const feed = startFeed();
    feed.publish("0.1.0", undefined, false);
    feed.point(pointer);

    const failure = await failureOf(
      obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }),
    );

    expect(failure.code).toBe("UPDATE_FEED_INVALID");
    expect(feed.requested).toEqual(["/installer/latest"]);
    expect(await readdir(installRoot)).toEqual([]);
  });
}

test("a pointer above 4096 bytes is refused", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0", undefined, false);
  feed.point(`0.1.0${" ".repeat(4096)}`);

  const failure = await failureOf(
    obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }),
  );

  expect(failure.code).toBe("UPDATE_FEED_INVALID");
  expect(feed.requested).toEqual(["/installer/latest"]);
});

async function expectRefusedBeforeDownload(
  feed: ReturnType<typeof startFeed>,
  code: UpdateError["code"],
) {
  const installRoot = await temporaryDirectory();
  const failure = await failureOf(
    obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }),
  );
  expect(failure.code).toBe(code);
  expect(feed.requested).toEqual(["/installer/latest", "/installer/0.1.0/manifest.json"]);
  expect(await readdir(installRoot)).toEqual([]);
  return failure;
}

test("a manifest that is not JSON is a feed failure", async () => {
  const feed = startFeed();
  feed.publish("0.1.0");
  feed.route("0.1.0/manifest.json", () => new Response("{not json"));

  await expectRefusedBeforeDownload(feed, "UPDATE_FEED_INVALID");
});

test("a manifest above 1 MiB is a feed failure", async () => {
  const feed = startFeed();
  feed.publish("0.1.0");
  feed.route("0.1.0/manifest.json", () => new Response(Buffer.alloc(1024 * 1024 + 1, 0x20)));

  await expectRefusedBeforeDownload(feed, "UPDATE_FEED_INVALID");
});

const invalidManifests: Array<[string, (manifest: InstallerManifest, target: string) => void]> = [
  ["declares schema_version 2", (manifest) => void (manifest.schema_version = 2)],
  ["has no commit", (manifest) => void delete manifest.commit],
  [
    "has an uppercase checksum",
    (manifest, target) => {
      manifest.platforms[target]!.installer.checksum = "A".repeat(64);
    },
  ],
  [
    "has a short gzip checksum",
    (manifest, target) => {
      manifest.platforms[target]!.installer.gzip.checksum = "abc";
    },
  ],
  [
    "has a negative size",
    (manifest, target) => {
      manifest.platforms[target]!.installer.size = -1;
    },
  ],
  [
    "names the Windows files on a Unix target",
    (manifest, target) => {
      const entry = manifest.platforms[target]!.installer;
      entry.file = "coforge-installer.exe";
      entry.gzip.file = "coforge-installer.exe.gz";
    },
  ],
  [
    "names an unknown file",
    (manifest, target) => {
      manifest.platforms[target]!.installer.file = "evil" as never;
    },
  ],
  ["is another version's manifest", (manifest) => void (manifest.version = "0.1.1")],
  [
    "records a gzip above the transfer ceiling",
    (manifest, target) => {
      manifest.platforms[target]!.installer.gzip.size = 512 * 1024 * 1024 + 1;
    },
  ],
  [
    "records an installer above the expansion ceiling",
    (manifest, target) => {
      manifest.platforms[target]!.installer.size = 512 * 1024 * 1024 + 1;
    },
  ],
];
for (const [name, corrupt] of invalidManifests) {
  test(`a manifest that ${name} is refused before any download`, async () => {
    const feed = startFeed();
    feed.publish("0.1.0", (published) => corrupt(published.manifest, feed.target));

    await expectRefusedBeforeDownload(feed, "UPDATE_FEED_INVALID");
  });
}

test("a manifest without this machine's target is an unsupported target", async () => {
  const feed = startFeed("linux-arm64");
  feed.publish("0.1.0");

  const failure = await failureOf(
    obtainInstaller({
      feedUrl: feed.url,
      target: "darwin-arm64",
      installRoot: await temporaryDirectory(),
    }),
  );

  expect(failure.code).toBe("UPDATE_UNSUPPORTED_TARGET");
  expect(failure.message).toContain("darwin-arm64");
  expect(feed.requested).toEqual(["/installer/latest", "/installer/0.1.0/manifest.json"]);
});

test("the Windows targets fetch and keep the .exe", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed("windows-arm64");
  const published = feed.publish("0.1.0");

  const installer = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(installer.path).toBe(
    join(installRoot, "installer", sha256hex(published.binary), "coforge-installer.exe"),
  );
  expect(feed.requested).toEqual([
    "/installer/latest",
    "/installer/0.1.0/manifest.json",
    "/installer/0.1.0/windows-arm64/coforge-installer.exe.gz",
  ]);
});

/** The cached installers under an install root, whatever the module has or has not created. */
async function cachedInstallers(installRoot: string): Promise<string[]> {
  return (await readdir(join(installRoot, "installer")).catch(() => [])).sort();
}

async function expectIntegrityFailure(
  feed: ReturnType<typeof startFeed>,
  message?: string,
): Promise<void> {
  const installRoot = await temporaryDirectory();
  const failure = await failureOf(
    obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }),
  );
  expect(failure.code).toBe("UPDATE_INTEGRITY_FAILED");
  if (message) expect(failure.message).toContain(message);
  // Nothing unverified stays behind, not even the directory named by the recorded checksum.
  expect(await cachedInstallers(installRoot)).toEqual([]);
}

test("a gzip larger than its recorded size fails its integrity check", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.manifest.platforms[feed.target]!.installer.gzip.size = published.gzip.byteLength - 1;
  });

  await expectIntegrityFailure(feed, "larger than its recorded size");
});

test("a gzip smaller than its recorded size fails its integrity check", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.manifest.platforms[feed.target]!.installer.gzip.size = published.gzip.byteLength + 1;
  });

  await expectIntegrityFailure(feed);
});

test("a gzip whose checksum differs from the manifest fails its integrity check", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.manifest.platforms[feed.target]!.installer.gzip.checksum = "0".repeat(64);
  });

  await expectIntegrityFailure(feed);
});

test("an expanded installer whose checksum differs from the manifest fails its integrity check", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.manifest.platforms[feed.target]!.installer.checksum = "0".repeat(64);
  });

  await expectIntegrityFailure(feed);
});

test("an expanded installer shorter than its recorded size fails its integrity check", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.manifest.platforms[feed.target]!.installer.size = published.binary.byteLength + 1;
  });

  await expectIntegrityFailure(feed);
});

test("a gzip bomb is stopped at the recorded expansion size", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    // An honest gzip identity around a payload far larger than the manifest says it expands to.
    published.gzip = Bun.gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const entry = published.manifest.platforms[feed.target]!.installer;
    entry.gzip.size = published.gzip.byteLength;
    entry.gzip.checksum = sha256hex(published.gzip);
  });

  await expectIntegrityFailure(feed, "exceeds recorded size");
});

test("bytes that are not gzip fail even when the manifest records them faithfully", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.gzip = Buffer.from("this is not gzip");
    const entry = published.manifest.platforms[feed.target]!.installer;
    entry.gzip.size = published.gzip.byteLength;
    entry.gzip.checksum = sha256hex(published.gzip);
  });

  await expectIntegrityFailure(feed, "compressed artifact is invalid");
});

test("a truncated gzip fails even when the manifest records it faithfully", async () => {
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.gzip = published.gzip.subarray(0, published.gzip.byteLength - 8);
    const entry = published.manifest.platforms[feed.target]!.installer;
    entry.gzip.size = published.gzip.byteLength;
    entry.gzip.checksum = sha256hex(published.gzip);
  });

  await expectIntegrityFailure(feed);
});

for (const object of ["latest", "0.1.0/manifest.json", "0.1.0/linux-x64/coforge-installer.gz"]) {
  test(`a redirect of installer/${object} is refused and never followed`, async () => {
    const installRoot = await temporaryDirectory();
    const feed = startFeed();
    const published = feed.publish("0.1.0");
    // A redirect that still carries a usable body: only refusing the redirect stops it.
    const body = object === "latest" ? "0.1.0" : object.endsWith(".gz") ? published.gzip : "{}";
    feed.route(object, () => {
      return new Response(Buffer.from(body), {
        status: 302,
        headers: { Location: "/installer/elsewhere" },
      });
    });
    feed.route("elsewhere", () => new Response(Buffer.from(body)));

    const failure = await failureOf(
      obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }),
    );

    expect(failure.code).toBe("UPDATE_FEED_INVALID");
    expect(feed.requested).not.toContain("/installer/elsewhere");
    expect(await cachedInstallers(installRoot)).toEqual([]);
  });
}

const installerGzipPath = "/installer/0.1.0/linux-x64/coforge-installer.gz";

test("a verified copy in the cache is used without downloading the gzip again", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0");
  const first = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
  feed.requested.length = 0;

  const second = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(second).toEqual(first);
  // The pointer and manifest are read every time; only the gzip is skipped.
  expect(feed.requested).toEqual(["/installer/latest", "/installer/0.1.0/manifest.json"]);
});

test("a cached installer whose bytes changed is downloaded and verified again", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const first = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
  // Same size, one byte different: only hashing the file can tell.
  const tampered = Buffer.from(published.binary);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0xff;
  await Bun.write(first.path, tampered);
  feed.requested.length = 0;

  const second = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(second).toEqual(first);
  expect(feed.requested).toContain(installerGzipPath);
  expect(Buffer.from(await Bun.file(second.path).arrayBuffer())).toEqual(published.binary);
  expect(await cachedInstallers(installRoot)).toEqual([sha256hex(published.binary)]);
  expect(await readdir(join(installRoot, "installer", sha256hex(published.binary)))).toEqual([
    "coforge-installer",
  ]);
});

test("a truncated or emptied cached installer is downloaded again", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const first = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  for (const damaged of [published.binary.subarray(0, 5), Buffer.alloc(0)]) {
    await Bun.write(first.path, damaged);
    feed.requested.length = 0;

    await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

    expect(feed.requested).toContain(installerGzipPath);
    expect(Buffer.from(await Bun.file(first.path).arrayBuffer())).toEqual(published.binary);
  }
});

test("a cache entry that lost its file is downloaded again", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0");
  const first = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
  await rm(first.path);
  feed.requested.length = 0;

  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(feed.requested).toContain(installerGzipPath);
  expect(await Bun.file(first.path).exists()).toBe(true);
});

if (process.platform !== "win32") {
  test("a symlink or directory where the cached installer belongs is replaced, not trusted", async () => {
    const installRoot = await temporaryDirectory();
    const elsewhere = await temporaryDirectory();
    const feed = startFeed();
    const published = feed.publish("0.1.0");
    const first = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

    // A link to a file whose bytes are exactly right still is not the cached copy.
    const target = join(elsewhere, "coforge-installer");
    await Bun.write(target, published.binary);
    await rm(first.path);
    await symlink(target, first.path);
    feed.requested.length = 0;
    await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
    expect(feed.requested).toContain(installerGzipPath);
    expect((await lstat(first.path)).isFile()).toBe(true);

    // The size check alone would catch a link whose own size is not the installer's, so make it
    // equal: a link's size is the length of its target, and this one is that many characters long.
    const padded = "x".repeat(published.binary.byteLength);
    await Bun.write(join(first.path, "..", padded), published.binary);
    await rm(first.path);
    await symlink(padded, first.path);
    expect((await lstat(first.path)).size).toBe(published.binary.byteLength);
    feed.requested.length = 0;
    await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
    expect(feed.requested).toContain(installerGzipPath);
    expect((await lstat(first.path)).isFile()).toBe(true);

    await rm(first.path);
    await mkdir(first.path);
    feed.requested.length = 0;
    await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
    expect(feed.requested).toContain(installerGzipPath);
    expect((await lstat(first.path)).isFile()).toBe(true);
  });
}

/** An installer the cache already holds, last used at `usedAt` (a fixed past date, so the order
 * of use never depends on the clock or on how fast the test runs). The time of use is the
 * installer file's own modification time. */
async function seedInstaller(installRoot: string, label: string, usedAt: Date): Promise<string> {
  const bytes = Buffer.from(`older installer ${label}\n`);
  const checksum = sha256hex(bytes);
  const directory = join(installRoot, "installer", checksum);
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "coforge-installer"), bytes);
  await utimes(join(directory, "coforge-installer"), usedAt, usedAt);
  return checksum;
}

const day = (number: number) => new Date(`2001-01-0${number}T00:00:00Z`);

test("keeps the current installer and the two most recently used others, and nothing else", async () => {
  const installRoot = await temporaryDirectory();
  const older = [
    await seedInstaller(installRoot, "one", day(1)),
    await seedInstaller(installRoot, "two", day(2)),
    await seedInstaller(installRoot, "three", day(3)),
    await seedInstaller(installRoot, "four", day(4)),
  ];
  // Things that are not cached installers are never the module's to delete.
  const cacheRoot = join(installRoot, "installer");
  await mkdir(join(cacheRoot, "notes"));
  await Bun.write(join(cacheRoot, "README"), "not an installer");
  await mkdir(join(cacheRoot, "A".repeat(64)));
  await Bun.write(join(cacheRoot, "b".repeat(64)), "a file named like a checksum");
  await utimes(join(cacheRoot, "notes"), day(1), day(1));
  const feed = startFeed();
  const published = feed.publish("0.1.0");

  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(await cachedInstallers(installRoot)).toEqual(
    [
      sha256hex(published.binary),
      older[3]!,
      older[2]!,
      "A".repeat(64),
      "README",
      "b".repeat(64),
      "notes",
    ].sort(),
  );
});

/** A file whose modification time is `modifiedAt`. */
async function writeFileAt(path: string, text: string, modifiedAt: Date): Promise<void> {
  await Bun.write(path, text);
  await utimes(path, modifiedAt, modifiedAt);
}

/** What a run killed mid-expansion leaves behind. */
const partialFile = (directory: string, name: string) => join(directory, `.download-${name}`);

/** A checksum-named cache directory holding no verified installer, only `contents`, and last
 * modified at `modifiedAt`. */
async function seedUnverified(
  installRoot: string,
  label: string,
  modifiedAt: Date,
  contents: Record<string, string>,
): Promise<string> {
  const checksum = sha256hex(Buffer.from(label));
  const directory = join(installRoot, "installer", checksum);
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(contents)) {
    await writeFileAt(join(directory, name), text, modifiedAt);
  }
  await utimes(directory, modifiedAt, modifiedAt);
  return checksum;
}

test("a directory holding no verified installer does not count toward the copies kept", async () => {
  const installRoot = await temporaryDirectory();
  const older = [
    await seedInstaller(installRoot, "one", day(1)),
    await seedInstaller(installRoot, "two", day(2)),
    await seedInstaller(installRoot, "three", day(3)),
  ];
  // Modified just now, so another run may be filling it: it is left alone, and it is not a copy.
  // It is a killed run's partial file with no installer in it.
  const now = new Date();
  const killed = await seedUnverified(installRoot, "killed", now, {
    ".download-1234": "half an installer",
  });
  const feed = startFeed();
  const published = feed.publish("0.1.0");

  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(await cachedInstallers(installRoot)).toEqual(
    [sha256hex(published.binary), older[2]!, older[1]!, killed].sort(),
  );
});

test("copies are kept by when they were used, without being hashed to decide", async () => {
  const installRoot = await temporaryDirectory();
  const older = [
    await seedInstaller(installRoot, "one", day(1)),
    await seedInstaller(installRoot, "two", day(2)),
    await seedInstaller(installRoot, "three", day(3)),
  ];
  // Its bytes are not the installer its name records, but it was used most recently, so it is
  // kept. It is not hashed to find that out: a kept copy is verified when it is next used.
  const damaged = await seedUnverified(installRoot, "damaged", day(4), {
    "coforge-installer": "not the installer",
  });
  const feed = startFeed();
  const published = feed.publish("0.1.0");

  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(await cachedInstallers(installRoot)).toEqual(
    [sha256hex(published.binary), damaged, older[2]!].sort(),
  );
});

test("sweeps stale partial files and directories with nothing verified, never a fresh one", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const options = { feedUrl: feed.url, target: feed.target, installRoot };
  const current = (await obtainInstaller(options)).path;
  const older = await seedInstaller(installRoot, "older", day(2));
  const cacheRoot = join(installRoot, "installer");
  const currentDirectory = join(cacheRoot, sha256hex(published.binary));
  const olderDirectory = join(cacheRoot, older);
  const now = new Date();
  for (const directory of [currentDirectory, olderDirectory]) {
    await writeFileAt(partialFile(directory, "stale"), "half an installer", day(1));
    await writeFileAt(partialFile(directory, "fresh"), "half an installer", now);
  }
  await utimes(olderDirectory, day(2), day(2));
  const abandoned = await seedUnverified(installRoot, "abandoned", day(1), {
    ".download-stale": "half an installer",
  });
  const inUse = await seedUnverified(installRoot, "in use", now, {
    ".download-fresh": "half an installer",
  });

  await obtainInstaller(options);

  expect((await readdir(currentDirectory)).sort()).toEqual([
    ".download-fresh",
    "coforge-installer",
  ]);
  expect((await readdir(olderDirectory)).sort()).toEqual([".download-fresh", "coforge-installer"]);
  expect(await cachedInstallers(installRoot)).toEqual(
    [sha256hex(published.binary), older, inUse].sort(),
  );
  expect(abandoned).not.toBe(inUse);
  expect(await Bun.file(current).exists()).toBe(true);
});

test("the current installer survives even when it is the oldest, and a cache hit counts as use", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const checksums: string[] = [];
  for (const [index, version] of ["0.1.0", "0.1.1", "0.1.2"].entries()) {
    const published = feed.publish(version);
    const installer = await obtainInstaller({
      feedUrl: feed.url,
      target: feed.target,
      installRoot,
    });
    checksums.push(sha256hex(published.binary));
    await utimes(installer.path, day(index + 1), day(index + 1));
  }
  // The pointer moves back to the oldest version: the oldest copy is the current one.
  feed.point("0.1.0\n");
  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
  expect(await cachedInstallers(installRoot)).toEqual([...checksums].sort());

  // Having been used just now, it outranks the others when the next version arrives.
  const next = feed.publish("0.1.3");
  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
  expect(await cachedInstallers(installRoot)).toEqual(
    [sha256hex(next.binary), checksums[0]!, checksums[2]!].sort(),
  );
});

test("a failed download prunes nothing", async () => {
  const installRoot = await temporaryDirectory();
  const older = [
    await seedInstaller(installRoot, "one", day(1)),
    await seedInstaller(installRoot, "two", day(2)),
    await seedInstaller(installRoot, "three", day(3)),
    await seedInstaller(installRoot, "four", day(4)),
  ];
  const feed = startFeed();
  feed.publish("0.1.0", (published) => {
    published.manifest.platforms[feed.target]!.installer.gzip.checksum = "0".repeat(64);
  });

  await failureOf(obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }));

  expect(await cachedInstallers(installRoot)).toEqual([...older].sort());
});

test("a copy that cannot be deleted does not stop the others from being pruned", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
  // Pruning keeps the two most recently used copies and removes the rest, oldest first. The
  // refused copy is removed before the oldest one, so a refusal must not end the pruning.
  const four = await seedInstaller(installRoot, "four", day(4));
  const three = await seedInstaller(installRoot, "three", day(3));
  const two = await seedInstaller(installRoot, "two", day(2));
  await seedInstaller(installRoot, "one", day(1));
  undeletableCopies.add(join(installRoot, "installer", two));
  try {
    const installer = await obtainInstaller({
      feedUrl: feed.url,
      target: feed.target,
      installRoot,
    });
    expect(installer.version).toBe("0.1.0");
    expect(await cachedInstallers(installRoot)).toEqual(
      [sha256hex(published.binary), four, three, two].sort(),
    );
  } finally {
    undeletableCopies.clear();
  }
});

test("two runs racing for the same installer both succeed and leave one file", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const options = { feedUrl: feed.url, target: feed.target, installRoot };

  const [first, second] = await Promise.all([obtainInstaller(options), obtainInstaller(options)]);

  expect(second).toEqual(first);
  expect(Buffer.from(await Bun.file(first.path).arrayBuffer())).toEqual(published.binary);
  expect(await readdir(join(first.path, ".."))).toEqual(["coforge-installer"]);
});

test("leaves no temporary files behind, whether the run succeeds or fails", async () => {
  const installRoot = await temporaryDirectory();
  const scratch = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0");
  const hostTemporary = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });
    feed.publish("0.1.1", (published) => {
      published.manifest.platforms[feed.target]!.installer.gzip.checksum = "0".repeat(64);
    });
    await failureOf(obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }));
  } finally {
    if (hostTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = hostTemporary;
  }

  expect(await readdir(scratch)).toEqual([]);
});

if (process.platform !== "win32") {
  test("the installer it returns is an executable file", async () => {
    const installRoot = await temporaryDirectory();
    const feed = startFeed();
    feed.publish("0.1.0");

    const installer = await obtainInstaller({
      feedUrl: feed.url,
      target: feed.target,
      installRoot,
    });

    const child = Bun.spawn({ cmd: [installer.path], stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  });
}

function permissionDenied(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

test("a refused rename is not a failure when a racing run already placed the verified installer", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const directory = join(installRoot, "installer", sha256hex(published.binary));
  // The other run finishes while this one is still downloading, and has already started its copy.
  feed.route("0.1.0/linux-x64/coforge-installer.gz", async () => {
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "coforge-installer"), published.binary);
    return new Response(Buffer.from(published.gzip));
  });
  refusedRename = permissionDenied();

  const installer = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(installer.path).toBe(join(directory, "coforge-installer"));
  expect(Buffer.from(await Bun.file(installer.path).arrayBuffer())).toEqual(published.binary);
  // The run's own partial file is gone, and nothing else was left in the entry.
  expect(await readdir(directory)).toEqual(["coforge-installer"]);
});

test("a refused rename with no verified installer in place fails as itself and leaves nothing", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  feed.publish("0.1.0");
  refusedRename = permissionDenied();

  const failure = await obtainInstaller({
    feedUrl: feed.url,
    target: feed.target,
    installRoot,
  }).catch((error: NodeJS.ErrnoException) => error);

  expect(failure).toBe(refusedRename);
  expect(await cachedInstallers(installRoot)).toEqual([]);
});

test("a refused rename does not excuse a damaged installer that is in place", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const directory = join(installRoot, "installer", sha256hex(published.binary));
  feed.route("0.1.0/linux-x64/coforge-installer.gz", async () => {
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "coforge-installer"), "not the installer");
    return new Response(Buffer.from(published.gzip));
  });
  refusedRename = permissionDenied();

  const failure = await obtainInstaller({
    feedUrl: feed.url,
    target: feed.target,
    installRoot,
  }).catch((error: NodeJS.ErrnoException) => error);

  expect(failure).toBe(refusedRename);
  expect(await readdir(directory)).toEqual(["coforge-installer"]);
});

/** Runs `operation` with the installer's warnings captured, and returns them. */
async function warningsDuring(operation: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => void warnings.push(record.message.join("")) },
    loggers: [
      {
        category: ["coforge", "computer", "installer"],
        sinks: ["capture"],
        lowestLevel: "warning",
      },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  try {
    await operation();
  } finally {
    await reset();
  }
  return warnings;
}

test("only a damaged copy found in the cache is reported as being downloaded again", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const options = { feedUrl: feed.url, target: feed.target, installRoot };
  const first = await obtainInstaller(options);

  expect(await warningsDuring(() => obtainInstaller(options))).toEqual([]);

  await Bun.write(first.path, "not the installer");
  expect(await warningsDuring(() => obtainInstaller(options))).toEqual([
    "A cached installer failed verification; downloading it again",
  ]);
  expect(Buffer.from(await Bun.file(first.path).arrayBuffer())).toEqual(published.binary);
});

test("a refused rename that meets a damaged copy fails without claiming to download again", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const directory = join(installRoot, "installer", sha256hex(published.binary));
  feed.route("0.1.0/linux-x64/coforge-installer.gz", async () => {
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "coforge-installer"), "not the installer");
    return new Response(Buffer.from(published.gzip));
  });
  refusedRename = permissionDenied();

  const warnings = await warningsDuring(() =>
    obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot }).catch(() => {}),
  );

  expect(warnings).toEqual([]);
});

test("accepting the installer a racing run placed does not fail when the run's own partial file cannot be removed", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const directory = join(installRoot, "installer", sha256hex(published.binary));
  feed.route("0.1.0/linux-x64/coforge-installer.gz", async () => {
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "coforge-installer"), published.binary);
    return new Response(Buffer.from(published.gzip));
  });
  refusedRename = permissionDenied();
  refusedPartialRemoval = permissionDenied();

  const installer = await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

  expect(installer.path).toBe(join(directory, "coforge-installer"));
  // The leftover is a fresh partial file: a later run sweeps it once it is stale.
  expect((await readdir(directory)).filter((name) => name.startsWith(".download-"))).toHaveLength(
    1,
  );
});

test("a directory reused from an earlier run is not pruned by another run while this one places into it", async () => {
  const installRoot = await temporaryDirectory();
  const feed = startFeed();
  const published = feed.publish("0.1.0");
  const options = { feedUrl: feed.url, target: feed.target, installRoot };
  // What a killed run left: an empty directory of this installer's checksum, long unchanged. It
  // is only in the cache's own directory listing, not a copy, so a prune may remove it.
  const directory = join(installRoot, "installer", sha256hex(published.binary));
  await mkdir(directory, { recursive: true });
  await utimes(directory, day(1), day(1));
  // Just before this run creates its partial file, the next version is published and another run
  // finishes, pruning the cache as it does.
  beforePartialOpened = async () => {
    const next = feed.publish("0.1.1");
    await obtainInstaller(options);
    expect(await cachedInstallers(installRoot)).toContain(sha256hex(next.binary));
  };

  const installer = await obtainInstaller(options);

  expect(installer.version).toBe("0.1.0");
  expect(Buffer.from(await Bun.file(installer.path).arrayBuffer())).toEqual(published.binary);
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

for (const [minutes, swept] of [
  [59, false],
  [61, true],
] as const) {
  test(`a partial file unchanged for ${minutes} minutes is ${swept ? "swept" : "left"}`, async () => {
    const installRoot = await temporaryDirectory();
    const feed = startFeed();
    const published = feed.publish("0.1.0");
    const options = { feedUrl: feed.url, target: feed.target, installRoot };
    const directory = join((await obtainInstaller(options)).path, "..");
    await writeFileAt(partialFile(directory, "old"), "half an installer", minutesAgo(minutes));

    await obtainInstaller(options);

    expect((await readdir(directory)).sort()).toEqual(
      swept ? ["coforge-installer"] : [".download-old", "coforge-installer"],
    );
    expect(await cachedInstallers(installRoot)).toEqual([sha256hex(published.binary)]);
  });

  test(`a directory holding nothing verified, unchanged for ${minutes} minutes, is ${swept ? "removed" : "left"}`, async () => {
    const installRoot = await temporaryDirectory();
    const feed = startFeed();
    const published = feed.publish("0.1.0");
    const abandoned = await seedUnverified(installRoot, "abandoned", minutesAgo(minutes), {
      ".download-old": "half an installer",
    });

    await obtainInstaller({ feedUrl: feed.url, target: feed.target, installRoot });

    expect(await cachedInstallers(installRoot)).toEqual(
      (swept ? [sha256hex(published.binary)] : [sha256hex(published.binary), abandoned]).sort(),
    );
  });
}
