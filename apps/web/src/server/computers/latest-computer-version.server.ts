import { isValidReleaseVersion } from "@lrm/coforge-sdk/internal";

/** The release feed answers a version string that changes at most once per release, so a
 * short-TTL module cache keeps the Computers page's loader off the network path: the first read
 * in a window fetches, every read within the window reuses the answer. A failed fetch is also
 * cached briefly (a shorter TTL) so an unreachable feed turns into one bounded stall per window
 * instead of one on every page load. Single-instance server, so a module global is the cache. */
const VERSION_TTL_MS = 60_000;
const VERSION_FAILURE_TTL_MS = 10_000;
let versionCache: { value: string | null; at: number } | undefined;
/** A miss refresh shares one fetch across every caller; an expired-but-known value answers
 * immediately (stale-while-refresh) so a heartbeat or ready never waits on the feed. */
let refreshing: Promise<void> | undefined;

async function refresh(feedUrl: string, fetchImpl: typeof fetch, now: () => number): Promise<void> {
  try {
    const response = await fetchImpl(`${feedUrl}/latest`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error("release feed unavailable");
    const version = (await response.text()).trim();
    const value = isValidReleaseVersion(version) ? version : null;
    versionCache = { value, at: now() };
  } catch {
    // Feed down or unparsable: remember the miss briefly so page loads during an outage
    // skip the stall, but let the next read retry rather than pinning the failure a minute.
    versionCache = { value: null, at: now() };
  }
}

/** One feed read through the TTL cache; tests inject the fetch so there is no network. A fresh
 * value answers instantly; an expired one answers stale while a shared background fetch runs;
 * only the first-ever read (nothing cached) waits — and it waits on the shared fetch too. */
export async function readLatestComputerVersion(
  feedUrl: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now,
): Promise<string | null> {
  if (
    versionCache &&
    now() - versionCache.at <
      (versionCache.value === null ? VERSION_FAILURE_TTL_MS : VERSION_TTL_MS)
  )
    return versionCache.value;
  refreshing ??= refresh(feedUrl, fetchImpl, now).finally(() => {
    refreshing = undefined;
  });
  // Only a real version is worth serving stale; an expired miss has nothing to answer with,
  // so its caller joins the shared refresh — one bounded stall per window, as before.
  if (versionCache?.value) return versionCache.value;
  await refreshing;
  return versionCache?.value ?? null;
}
