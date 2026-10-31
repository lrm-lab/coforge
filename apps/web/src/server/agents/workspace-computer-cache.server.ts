/** A daemon's Activity frames repeat the same Workspace–Computer pair; a short TTL covers bursts. */
const WORKSPACE_COMPUTER_TTL_MS = 30_000;
const WORKSPACE_COMPUTER_CACHE_MAX_ENTRIES = 512;

/**
 * `check`, remembering each positive answer for a short time, so a daemon's stream of Activity
 * frames does not re-read the same `workspaceComputer` row for every frame. Keyed by Workspace
 * and Computer. Only a Computer that belongs is remembered: a negative or failed check is asked
 * again, so a fresh attach is seen at once. Repeats renew the entry; idle entries expire.
 * Process-local and bounded: the oldest entry goes first.
 *
 * The stale window is accepted: a Computer detached within the TTL may still publish for up to
 * `ttlMs`. Every frame is still gated per Agent by `agentBelongsToComputer`, and the connect
 * proxy re-verifies the pair when the daemon's connection opens.
 */
export function cachedWorkspaceComputerCheck(
  check: (workspaceId: string, computerId: string) => Promise<boolean>,
  {
    ttlMs = WORKSPACE_COMPUTER_TTL_MS,
    maxEntries = WORKSPACE_COMPUTER_CACHE_MAX_ENTRIES,
    now = Date.now,
  }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): (workspaceId: string, computerId: string) => Promise<boolean> {
  const entries = new Map<string, { at: number }>();
  return async (workspaceId, computerId) => {
    const key = [workspaceId, computerId].join("\u0000");
    const known = entries.get(key);
    if (known && now() - known.at < ttlMs) {
      known.at = now();
      return true;
    }
    if (!(await check(workspaceId, computerId))) return false;
    entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    entries.set(key, { at: now() });
    return true;
  };
}
