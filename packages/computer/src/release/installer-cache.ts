import { lstat, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";

/** A cache directory is named by the sha256 of the installer binary it holds. */
export const CHECKSUM_DIRECTORY = /^[0-9a-f]{64}$/;
const INSTALLER_FILES = ["coforge-installer", "coforge-installer.exe"];

/** When the copy in a checksum-named `directory` was last used, or `undefined` if the directory
 * holds no installer file. Its bytes are not hashed here. */
export async function usedAtOfCopy(directory: string): Promise<number | undefined> {
  for (const name of INSTALLER_FILES) {
    const info = await lstat(join(directory, name)).catch(() => undefined);
    if (info?.isFile()) return info.mtimeMs;
  }
  return undefined;
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
  const root = join(installRoot, "installer");
  const binaryName = target.startsWith("windows-") ? "coforge-installer.exe" : "coforge-installer";
  const copies: Array<{ checksum: string; path: string; usedAt: number }> = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !CHECKSUM_DIRECTORY.test(entry.name)) continue;
    const path = join(root, entry.name, binaryName);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile()) copies.push({ checksum: entry.name, path, usedAt: info.mtimeMs });
  }
  copies.sort((a, b) => b.usedAt - a.usedAt || a.checksum.localeCompare(b.checksum));
  for (const { checksum, path } of copies) {
    if ((await sha256OfFile(path).catch(() => undefined)) !== checksum) continue;
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return { path };
  }
  return undefined;
}
