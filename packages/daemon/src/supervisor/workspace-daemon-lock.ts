import { rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { acquireProcessLock, isLockContention, type ProcessLock } from "#src/platform/process-lock";

const LOCK_RETRY_MS = 5_000;
const LOCK_FILE = "workspace-daemon-lock.sqlite";
const LOCK_OWNER_FILE = "workspace-daemon-lock.owner";

export type WorkspaceDaemonLockProbe = {
  held: boolean;
  holderPid: number | null;
};

/**
 * One Workspace daemon per binding, enforced inside the child itself. A child outlives its
 * Coordinator (it is spawned detached), so a restarted Coordinator can spawn a second child for
 * a binding whose first child still runs; only the child knows it is the second one. The lock
 * file lives in the binding's own state directory, so it is per binding by construction. A
 * contender waits for the holder to exit rather than racing it onto the cloud — which is how an
 * orphan holding a stale credential used to reconnect forever beside its replacement. The
 * holder's death releases the SQLite lock with its process, so the waiter always proceeds.
 */
export async function holdWorkspaceDaemonLock(
  stateDirectory: string,
  options: { signal?: AbortSignal; waiting?: () => void; retryMs?: number; pid?: number } = {},
): Promise<ProcessLock> {
  const path = join(stateDirectory, LOCK_FILE);
  const ownerPath = join(stateDirectory, LOCK_OWNER_FILE);
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const holderPid = options.pid ?? process.pid;
  let announced = false;
  for (;;) {
    try {
      const lock = acquireProcessLock(path);
      try {
        writeFileSync(ownerPath, String(holderPid), { mode: 0o600 });
      } catch {
        // Best-effort diagnostic metadata; the SQLite RESERVED lock is authoritative.
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            rmSync(ownerPath, { force: true });
          } catch {
            // Best-effort cleanup before releasing the SQLite lock so we never clobber a successor.
          }
          lock.release();
        },
      };
    } catch (error) {
      if (!isLockContention(error)) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      if (!announced) {
        announced = true;
        options.waiting?.();
      }
      await Bun.sleep(retryMs);
      if (options.signal?.aborted) throw options.signal.reason;
    }
  }
}

/**
 * Read-only probe of `workspace-daemon-lock.sqlite` for `status` and `doctor`. Never creates the
 * lock file when absent, and trusts the companion owner file only while SQLite reports the
 * RESERVED lock is actively held.
 */
export async function readWorkspaceDaemonLockHolder(
  stateDirectory: string,
): Promise<WorkspaceDaemonLockProbe> {
  const path = join(stateDirectory, LOCK_FILE);
  if (!(await Bun.file(path).exists())) {
    return { held: false, holderPid: null };
  }
  try {
    const probe = acquireProcessLock(path);
    probe.release();
    return { held: false, holderPid: null };
  } catch (error) {
    if (!isLockContention(error)) return { held: false, holderPid: null };
    try {
      const text = (await readFile(join(stateDirectory, LOCK_OWNER_FILE), "utf8")).trim();
      const pid = Number(text);
      return {
        held: true,
        holderPid: Number.isInteger(pid) && pid > 0 ? pid : null,
      };
    } catch {
      return { held: true, holderPid: null };
    }
  }
}
