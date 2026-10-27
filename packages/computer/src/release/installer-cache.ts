import { lstat, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";

/** The layout of the installer cache, `<install root>/installer/<sha256>/<binary>`: a directory is
 * named by the sha256 of the installer binary it holds. */
const CHECKSUM_DIRECTORY = /^[0-9a-f]{64}$/;

/** The installer's file name for a release target, which is also its name in the feed. */
export function installerBinaryName(target: string): string {
  return target.startsWith("windows-") ? "coforge-installer.exe" : "coforge-installer";
}

/** Where the installer with one checksum is kept. */
export type CacheLocation = { root: string; directory: string; path: string };

const cacheRoot = (installRoot: string): string => join(installRoot, "installer");

export function cacheLocation(
  installRoot: string,
  target: string,
  checksum: string,
): CacheLocation {
  const root = cacheRoot(installRoot);
  const directory = join(root, checksum);
  return { root, directory, path: join(directory, installerBinaryName(target)) };
}

/** Stamps the installer as used now. A copy's time of use is its installer file's modification
 * time, whether it was just downloaded or just found in the cache; only the order of use depends
 * on it, so a failure to stamp is not worth failing the run. */
export async function markUsed(cache: CacheLocation): Promise<void> {
  const now = new Date();
  await utimes(cache.path, now, now).catch(() => {});
}

/** A checksum-named directory of the cache. `usedAt` is when its installer file was last used, and
 * `undefined` when the directory holds no installer file (a killed run's leftover). The bytes are
 * not hashed here. */
export type CachedCopy = CacheLocation & { checksum: string; usedAt: number | undefined };

/**
 * Every checksum-named directory under the cache root, most recently used first, then by checksum;
 * those holding no installer file come last. A link or a non-file at the installer's name does
 * not count as a copy. Anything not named by a checksum is not the cache's own and is left out.
 */
export async function listCachedCopies(installRoot: string, target: string): Promise<CachedCopy[]> {
  const copies: CachedCopy[] = [];
  for (const entry of await readdir(cacheRoot(installRoot), { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!entry.isDirectory() || !CHECKSUM_DIRECTORY.test(entry.name)) continue;
    const location = cacheLocation(installRoot, target, entry.name);
    const info = await lstat(location.path).catch(() => undefined);
    copies.push({
      ...location,
      checksum: entry.name,
      usedAt: info?.isFile() ? info.mtimeMs : undefined,
    });
  }
  return copies.sort(
    (a, b) =>
      (b.usedAt ?? -Infinity) - (a.usedAt ?? -Infinity) || a.checksum.localeCompare(b.checksum),
  );
}

export async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * The most recently used installer kept under `<install root>/installer/<sha256>/` that still
 * hashes to its directory's name, for when the release feed cannot be reached. A copy that is a
 * link, is not a file, or fails the hash is skipped, so a damaged newest copy never hides an
 * intact older one. The chosen copy is stamped as used now. `undefined` when none verifies.
 */
export async function cachedInstaller(
  installRoot: string,
  target: string,
): Promise<{ path: string } | undefined> {
  for (const copy of await listCachedCopies(installRoot, target)) {
    if (copy.usedAt === undefined) continue;
    if ((await sha256OfFile(copy.path).catch(() => undefined)) !== copy.checksum) continue;
    await markUsed(copy);
    return { path: copy.path };
  }
  return undefined;
}
