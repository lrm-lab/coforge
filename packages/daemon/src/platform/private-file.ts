import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes a service definition the daemon hands to the OS (a launchd plist, a systemd user unit):
 * the parent directory is created owner-only (`0700`) when missing and the file is written
 * owner-read/write (`0600`) as UTF-8. `daemon-host/launchd.ts`, `daemon-host/systemd-user.ts` and
 * `supervisor/systemd-workspace-instance.ts` each wrote this default out by hand.
 *
 * `mode` applies only when a directory or file is created; an existing one keeps its permissions,
 * exactly as before.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}
