import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";
import { isValidReleaseVersion, thrownMessage } from "@lrm/coforge-sdk/internal";
import type { z } from "zod";

import { UpdateError } from "#src/updater";
import { runInstallationSource } from "./installation-source";
import { InstallerManifestSchema } from "./installer-contract";

/** The same ceilings as the install scripts and the installer crate: a manifest is at most 1 MiB;
 * neither the compressed nor the expanded installer may be recorded above 512 MiB. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;

/** How many cached installers other than the current one are kept, most recently used first. */
const KEEP_OTHER_INSTALLERS = 2;
const CHECKSUM_DIRECTORY = /^[0-9a-f]{64}$/;
const INSTALLER_FILES = ["coforge-installer", "coforge-installer.exe"];
/** A run writes its expansion to `.download-<uuid>` next to the final name. */
const PARTIAL_PREFIX = ".download-";
/** How long a partial file, or a directory holding nothing verified, may sit unchanged before it
 * is taken to belong to a run that no longer exists. */
const STALE_AFTER_MS = 60 * 60 * 1000;

const logger = getLogger(["coforge", "computer", "installer"]);

export type InstallerLaunchOptions = {
  /** The release feed, as `release-channel.ts` compiles it in; the installer feed is its
   * `installer/` prefix. */
  feedUrl: string;
  /** This machine's release target, e.g. `linux-x64` (`currentComputerPlatform`). */
  target: string;
  /** The install root; the verified copy is kept in `<install root>/installer/<sha256>/`. */
  installRoot: string;
};

export type VerifiedInstaller = { path: string; version: string };

type InstallerEntry = z.infer<typeof InstallerManifestSchema>["platforms"][string]["installer"];

/**
 * Obtains the current `coforge-installer` for this machine: reads `installer/latest`, checks the
 * installer manifest, downloads this target's gzip, verifies its size and checksum, expands it
 * under the recorded size, and verifies the expanded size and checksum. The result is a
 * private, verified executable in the install root: a copy already there is used only after it
 * is hashed again, and the directory is `0700`, which keeps it as verified until it is run.
 *
 * `UPDATE_FEED_INVALID` is anything `runInstallationSource` throws (the install script failing or
 * refusing a transfer, and also that function failing to write or start the script) and a pointer
 * or manifest that is not valid; `UPDATE_INTEGRITY_FAILED` is a size, checksum, or gzip check;
 * `UPDATE_UNSUPPORTED_TARGET` is a manifest with no entry for this target. This module's own
 * filesystem work (its download directory and the cache) is not wrapped: those errors propagate
 * as themselves. Nothing unverified is left in the install root, and nothing is pruned on failure.
 */
export async function obtainInstaller(options: InstallerLaunchOptions): Promise<VerifiedInstaller> {
  const baseUrl = `${options.feedUrl.replace(/\/+$/, "")}/installer`;
  const version = await runSource({
    baseUrl,
    target: options.target,
    selection: "latest",
    quietHeader: true,
  });
  if (version === "latest" || !isValidReleaseVersion(version)) {
    throw feedInvalid("installer/latest does not name a valid version");
  }
  const work = await mkdtemp(join(tmpdir(), "coforge-installer-download-"));
  try {
    const prepare = (phase: "manifest" | "installer") =>
      runSource({
        baseUrl,
        target: options.target,
        selection: version,
        directory: work,
        quietHeader: true,
        phase,
      });
    await prepare("manifest");
    const entry = await readInstallerEntry(work, version, options.target);
    const cache = cacheLocation(options.installRoot, entry);
    const cached = await inspectCachedCopy(cache, entry);
    if (cached === "damaged") {
      logger.warn("A cached installer failed verification; downloading it again", {
        path: cache.path,
      });
    }
    if (cached !== "verified") {
      await prepare("installer");
      await placeVerifiedCopy(cache, join(work, entry.gzip.file), entry);
    }
    await markUsed(cache);
    await pruneCache(cache, entry.checksum);
    return { path: cache.path, version };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function feedInvalid(message: string): UpdateError {
  return new UpdateError("UPDATE_FEED_INVALID", message);
}

function integrity(message: string): UpdateError {
  return new UpdateError("UPDATE_INTEGRITY_FAILED", message);
}

/** Runs the embedded install script. Whatever it throws, including its own local failures, is
 * reported as `UPDATE_FEED_INVALID`, as `ComputerUpdater` reports the same calls. */
async function runSource(options: Parameters<typeof runInstallationSource>[0]): Promise<string> {
  try {
    return await runInstallationSource(options);
  } catch (error) {
    throw feedInvalid(thrownMessage(error));
  }
}

/** The manifest fetched into `directory` by the `manifest` phase, checked as the installer
 * manifest of exactly `version`, and this target's entry in it. */
async function readInstallerEntry(
  directory: string,
  version: string,
  target: string,
): Promise<InstallerEntry> {
  const file = Bun.file(join(directory, "manifest.json"));
  if (file.size > MAX_MANIFEST_BYTES) throw feedInvalid("installer manifest exceeds size limit");
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw feedInvalid("installer manifest is not valid JSON");
  }
  const parsed = InstallerManifestSchema.safeParse(value);
  if (!parsed.success) throw feedInvalid("installer manifest schema is invalid");
  const manifest = parsed.data;
  // Fetched from `<version>/manifest.json`, so its own version is redundant unless it is also
  // checked: an object served under the wrong version path would otherwise pass every other check.
  if (manifest.version !== version) {
    throw feedInvalid(
      `installer manifest version ${manifest.version} does not match requested version ${version}`,
    );
  }
  if (!Object.hasOwn(manifest.platforms, target)) {
    throw new UpdateError(
      "UPDATE_UNSUPPORTED_TARGET",
      `installer manifest has no platform entry for ${target}`,
    );
  }
  const { installer } = manifest.platforms[target]!;
  // The file names are pinned to the feed's fixed layout, not accepted as "some allowed name": the
  // install script derives the same gzip name from the target, so a manifest naming the other one
  // describes an object this module never fetches.
  const windows = target.startsWith("windows-");
  const binaryName = windows ? "coforge-installer.exe" : "coforge-installer";
  const gzipName = `${binaryName}.gz`;
  if (installer.file !== binaryName || installer.gzip.file !== gzipName) {
    throw feedInvalid(
      `installer manifest entry for ${target} names ${installer.file} and ${installer.gzip.file}, not ${binaryName} and ${gzipName}`,
    );
  }
  for (const object of [installer.gzip, installer]) {
    if (object.size > MAX_BINARY_BYTES) {
      throw feedInvalid(
        `${object.file} is recorded as ${object.size} bytes, above the ${MAX_BINARY_BYTES}-byte limit`,
      );
    }
  }
  return installer;
}

/** Where the installer with one checksum is kept: `<install root>/installer/<sha256>/<file>`. */
type CacheLocation = { root: string; directory: string; path: string };

function cacheLocation(installRoot: string, entry: InstallerEntry): CacheLocation {
  const root = join(installRoot, "installer");
  const directory = join(root, entry.checksum);
  return { root, directory, path: join(directory, entry.file) };
}

type CachedCopy = "verified" | "missing" | "damaged";

/** What the cache holds for this manifest entry, checked by hashing the file every time. A copy
 * that is missing or damaged is a miss like any other: the download that replaces it is verified
 * against the manifest whatever the cache held, so refusing to continue would only strand the
 * machine until someone cleared the directory. */
async function inspectCachedCopy(cache: CacheLocation, entry: InstallerEntry): Promise<CachedCopy> {
  const info = await lstat(cache.path).catch(() => undefined);
  if (!info) return "missing";
  try {
    // A link is not the copy: its target is neither ours to trust nor ours to keep.
    const verified =
      info.isFile() &&
      info.size === entry.size &&
      (await sha256OfFile(cache.path)) === entry.checksum;
    return verified ? "verified" : "damaged";
  } catch {
    return "damaged";
  }
}

/** Expands the verified download into the cache. The bytes are written next to their final name,
 * inside the private directory, and renamed into place only once every check has passed, so a
 * reader never sees a partial installer and two runs racing for one checksum both end with the
 * same file. */
async function placeVerifiedCopy(
  cache: CacheLocation,
  gzipPath: string,
  entry: InstallerEntry,
): Promise<void> {
  // The download is checked before anything is created in the cache, so the directory is made,
  // stamped, and filled within moments rather than across the hashing of the download.
  await verifyDownload(gzipPath, entry);
  await mkdir(cache.directory, { recursive: true, mode: 0o700 });
  // The directory may be one a killed run left long ago, which a prune by another run would take
  // for abandoned: stamp it as changed now, before this run depends on it.
  const now = new Date();
  await utimes(cache.directory, now, now).catch(() => {});
  // A file or link at the final name is replaced by the rename; a directory would block it.
  if ((await lstat(cache.path).catch(() => undefined))?.isDirectory()) {
    await rm(cache.path, { recursive: true, force: true });
  }
  const partial = join(cache.directory, `${PARTIAL_PREFIX}${crypto.randomUUID()}`);
  try {
    await expandDownload(gzipPath, entry, partial);
    try {
      await rename(partial, cache.path);
    } catch (error) {
      // Windows refuses to replace an executable that is running, and a racing run that placed
      // the same verified installer first may already have started it. That copy is exactly
      // what this run was about to place, so it is accepted; any other refusal is a failure.
      if ((await inspectCachedCopy(cache, entry)) !== "verified") throw error;
      // Housekeeping: a partial file that stays is swept once it is stale.
      await rm(partial, { force: true }).catch(() => {});
    }
  } catch (error) {
    await rm(partial, { force: true });
    // Nothing verified was placed, so the directory named by the recorded checksum is empty
    // unless a concurrent run or an earlier verified copy owns it.
    await rmdir(cache.directory).catch(() => {});
    throw error;
  }
}

/** Stamps the installer as used now. A copy's time of use is its installer file's modification
 * time, whether it was just downloaded or just found in the cache; only the order of use depends
 * on it, so a failure to stamp is not worth failing the run. */
async function markUsed(cache: CacheLocation): Promise<void> {
  const now = new Date();
  await utimes(cache.path, now, now).catch(() => {});
}

/**
 * Keeps the current installer and the most recently used other copies, and removes what a killed
 * run left behind. Only directories named by a checksum are the cache's own; anything else there
 * is left alone. Removal is best effort: a copy that cannot be deleted, such as an executable still
 * running on Windows, stays until a later run, and never fails this one.
 *
 * Copies are ranked by when they were used, not by hashing them: hashing every cached installer on
 * each run would read hundreds of megabytes to decide what to delete. Only a directory holding an
 * installer file counts toward the ones kept, since a final name is renamed into place only after
 * verification; a directory a killed run left with just its partial file must not push out a good
 * older installer. A kept copy is still verified before it is ever used (`inspectCachedCopy`).
 *
 * Nothing here tells another process's live work from a dead run's leftover by owner, as the
 * installer crate does for its `.staging` directory (a process token in each name): that sweep
 * holds the machine mutation lock, so everything it did not make is stale, whereas runs of this
 * module overlap by design. What tells them apart is age. A run holds a partial file only while it
 * expands a download, and every write refreshes the file's modification time, so a partial file,
 * or a directory holding nothing verified, that has not changed for an hour belongs to no run.
 * A run's own partial file is always fresh, and is gone before this runs.
 */
async function pruneCache(cache: CacheLocation, current: string): Promise<void> {
  try {
    const now = Date.now();
    const copies: Array<{ name: string; usedAt: number }> = [];
    for (const entry of await readdir(cache.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CHECKSUM_DIRECTORY.test(entry.name)) continue;
      const directory = join(cache.root, entry.name);
      if (entry.name === current) {
        await removeStalePartials(directory, now);
        continue;
      }
      const modifiedAt = (await stat(directory).catch(() => undefined))?.mtimeMs;
      if (modifiedAt === undefined) continue;
      const usedAt = await usedAtOfCopy(directory);
      if (usedAt !== undefined) copies.push({ name: entry.name, usedAt });
      else if (now - modifiedAt > STALE_AFTER_MS) await removeAbandoned(directory, modifiedAt);
    }
    copies.sort((a, b) => b.usedAt - a.usedAt || a.name.localeCompare(b.name));
    for (const [index, { name }] of copies.entries()) {
      const directory = join(cache.root, name);
      if (index < KEEP_OTHER_INSTALLERS) await removeStalePartials(directory, now);
      else await removeDirectory(directory);
    }
  } catch {
    // Pruning is housekeeping, and the verified installer is already in place.
  }
}

/** Removes a directory that held nothing verified and had not changed since `modifiedAt`, unless
 * a run has begun using it in the meantime: it is looked at once more just before it goes. */
async function removeAbandoned(directory: string, modifiedAt: number): Promise<void> {
  if ((await stat(directory).catch(() => undefined))?.mtimeMs === modifiedAt) {
    await removeDirectory(directory);
  }
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function removeStalePartials(directory: string, now: number): Promise<void> {
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.startsWith(PARTIAL_PREFIX)) continue;
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile() && now - info.mtimeMs > STALE_AFTER_MS) {
      await rm(path, { force: true }).catch(() => {});
    }
  }
}

/** When the copy in a checksum-named `directory` was last used, or `undefined` if the directory
 * holds no installer file. Its bytes are not hashed here. */
async function usedAtOfCopy(directory: string): Promise<number | undefined> {
  for (const name of INSTALLER_FILES) {
    const info = await lstat(join(directory, name)).catch(() => undefined);
    if (info?.isFile()) return info.mtimeMs;
  }
  return undefined;
}

/** Checks the downloaded gzip against its recorded identity. Nothing of it is expanded before it
 * passes, so unverified bytes never reach the decompressor. */
async function verifyDownload(gzipPath: string, entry: InstallerEntry): Promise<void> {
  const compressed = entry.gzip;
  const file = Bun.file(gzipPath);
  if (file.size > compressed.size) {
    throw integrity(`release object is larger than its recorded size: ${compressed.file}`);
  }
  if (file.size !== compressed.size || (await sha256OfFile(gzipPath)) !== compressed.checksum) {
    throw integrity(`downloaded artifact failed integrity: ${compressed.file}`);
  }
}

/** Expands the verified gzip into `destination` (a new file) and checks the result against the
 * installer's recorded identity. The expansion stops at the recorded size, so a bomb never writes
 * more than the manifest promised. */
async function expandDownload(
  gzipPath: string,
  entry: InstallerEntry,
  destination: string,
): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  const output = await open(destination, "wx", 0o700);
  try {
    const reader = Bun.file(gzipPath)
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    try {
      while (true) {
        const chunk = await reader.read().catch(() => {
          throw integrity(`compressed artifact is invalid: ${entry.gzip.file}`);
        });
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > entry.size) throw integrity("decompressed artifact exceeds recorded size");
        hasher.update(chunk.value);
        await writeAll(output, chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    await output.close();
  }
  if (size !== entry.size || hasher.digest("hex") !== entry.checksum) {
    throw integrity(`downloaded artifact failed integrity: ${entry.file}`);
  }
}

async function writeAll(output: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += (await output.write(bytes, offset)).bytesWritten;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
