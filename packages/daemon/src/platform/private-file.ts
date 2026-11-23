import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes a service definition the daemon hands to the OS (a launchd plist, a systemd user unit):
 * the parent directory is created owner-only (`0700`) when missing and the file is written
 * owner-read/write (`0600`) as UTF-8. `daemon-host/launchd.ts`, `daemon-host/systemd-user.ts` and
 * `supervisor/systemd-workspace-instance.ts` each wrote this default out by hand.
 *
 * `mode` is applied unconditionally: an existing file is `chmod`-ed to it, so a file written by
 * an older build with a narrower mode is widened (or narrowed) on the next write.
 */
export async function writePrivateFile(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf8", mode });
  await chmod(path, mode);
}

/**
 * Like `writePrivateFile`, but a reader never sees a partial file: the content goes to a sibling
 * temporary file with `mode` applied, which is then renamed over `path` - the rename carries that
 * mode to the final file, so no `chmod` is needed after it.
 */
export async function writePrivateFileAtomic(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePrivateFile(temporary, content, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
