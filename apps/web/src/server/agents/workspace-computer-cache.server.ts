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
 * The TTL is only a backstop: an ownership write drops the entry at once through `forget`
 * (`workspace-computer-invalidation`), here and broadcast to every other web instance. Every
 * frame is still gated per Agent by `agentBelongsToComputer`, and the connect proxy re-verifies
 * the pair when the daemon's connection opens.
 */
export function cachedWorkspaceComputerCheck(
  check: (workspaceId: string, computerId: string) => Promise<boolean>,
  {
    ttlMs = WORKSPACE_COMPUTER_TTL_MS,
    maxEntries = WORKSPACE_COMPUTER_CACHE_MAX_ENTRIES,
    now = Date.now,
  }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): {
  check: (workspaceId: string, computerId: string) => Promise<boolean>;
  /** Drop every remembered answer for a Computer — or all of them when no id is given. */
  forget: (computerId?: string) => void;
} {
  const entries = new Map<string, { at: number }>();
  // A check issued before a `forget` can resolve after it: generation guards keep that stale
  // answer from re-entering the cache, where only the TTL would expire it.
  const generations = new Map<string, number>();
  let flushEpoch = 0;
  const generation = (computerId: string) => generations.get(computerId) ?? 0;
  const forget = (computerId?: string) => {
    if (computerId === undefined) {
      entries.clear();
      generations.clear();
      flushEpoch += 1;
      return;
    }
    generations.set(computerId, generation(computerId) + 1);
    const suffix = `${"\u0000"}${computerId}`;
    for (const key of entries.keys()) if (key.endsWith(suffix)) entries.delete(key);
  };
  return {
    forget,
    check: async (workspaceId, computerId) => {
      const key = [workspaceId, computerId].join("\u0000");
      const known = entries.get(key);
      if (known && now() - known.at < ttlMs) {
        known.at = now();
        return true;
      }
      const epoch = flushEpoch;
      const gen = generation(computerId);
      if (!(await check(workspaceId, computerId))) return false;
      if (flushEpoch !== epoch || generation(computerId) !== gen) return true;
      entries.delete(key);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(key, { at: now() });
      return true;
    },
  };
}
