/**
 * Polls `read` until it reports the exact scan this call started — never a stale one already in
 * the cache, and never the "pending" placeholder for a scan that hasn't finished yet. The previous
 * result stays whatever `read` returns while this waits, so a slow scan never has to blank the
 * caller's display back to empty.
 *
 * The scan is claimed before its id is handed out, so a read that shows another scan pending, or
 * none, with a result that is not this scan's means this scan has ended without one: its claim
 * expired on a Computer that never answered, a reset credit result or a sign-in ended it, or it
 * was joined and its publish failed. That read is returned instead of waiting out the rest of
 * the budget, once reads have agreed for two seconds: a login report ends the claim of the very
 * scan that found the change, and that scan's result follows a moment later.
 */
const ENDED_SCAN_READS = 20;

export async function waitForUsageScanResult<
  T extends { result?: { scanId: string }; pendingScanId?: string },
>(
  scanId: string,
  read: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  // A scan also waits for bounded auth collection (20s, plus one coalesced collection).
  // Match the server's 60s pending-scan lifetime instead of the old 15s usage-only budget.
  const over = (reading: T) =>
    reading.result?.scanId !== scanId && reading.pendingScanId !== scanId;
  let current = await read();
  let endedReads = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (current.result?.scanId === scanId) return current;
    endedReads = over(current) ? endedReads + 1 : 0;
    if (endedReads >= ENDED_SCAN_READS) return current;
    await sleep(100);
    current = await read();
  }
  if (current.result?.scanId !== scanId) throw new Error("usage scan timed out");
  return current;
}
