import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";
import type { ResetCreditRead } from "#src/server/computers/runtime-reset-credit.server";

/** How often the dialog asks for the Computer's answer. */
export const RESET_CREDIT_POLL_INTERVAL_MS = 1_500;
/** Past the Computer's worst case (three 20 second Codex requests and a usage read, about 90
 * seconds) and inside the server's 120 second pending lifetime. */
export const RESET_CREDIT_CLIENT_DEADLINE_MS = 100_000;

const sleepUnlessAborted = (signal: AbortSignal) => (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Asks for a started attempt's answer until it settles. A read that fails on the way (a dropped
 * connection, a gateway error) is asked again, not taken as an answer. The deadline and the
 * caller going away both end the wait as `unknown`: the credit may have been spent, so the
 * attempt stays open and its key is kept. A refusal to read is final.
 */
export async function awaitResetCredit(options: {
  read(): Promise<ResetCreditRead>;
  signal: AbortSignal;
  intervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Exclude<ResetCreditRead, { status: "pending" }>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUnlessAborted(options.signal);
  const intervalMs = options.intervalMs ?? RESET_CREDIT_POLL_INTERVAL_MS;
  const deadline = now() + (options.deadlineMs ?? RESET_CREDIT_CLIENT_DEADLINE_MS);
  while (!options.signal.aborted && now() <= deadline) {
    try {
      const read = await options.read();
      if (read.status !== "pending") return read;
    } catch {
      // The next read asks again.
    }
    await sleep(intervalMs);
  }
  return { status: "settled", outcome: "unknown" };
}

/**
 * Whether the cached usage holds the reading the Computer sent with this attempt's answer. The
 * server stores that reading under the attempt's request id, so the cache's latest scan id names
 * it. Any other id means no reading was stored (an older Computer, a reading the server could
 * not trust, a cache that failed) and the cached usage still counts the spent credit.
 */
export function usageCarriesAttempt(usage: UsageReadResult, requestId: string): boolean {
  return usage.result?.scanId === requestId;
}
