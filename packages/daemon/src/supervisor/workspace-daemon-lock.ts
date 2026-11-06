import { join } from "node:path";

import { acquireProcessLock, isLockContention, type ProcessLock } from "#src/platform/process-lock";

const LOCK_RETRY_MS = 5_000;

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
  options: { signal?: AbortSignal; waiting?: () => void; retryMs?: number } = {},
): Promise<ProcessLock> {
  const path = join(stateDirectory, "workspace-daemon-lock.sqlite");
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  let announced = false;
  for (;;) {
    try {
      return acquireProcessLock(path);
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
