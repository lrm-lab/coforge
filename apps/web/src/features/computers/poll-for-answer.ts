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
 * Asks for a started request's answer until it is no longer pending. Production closes a request
 * idle for about ten seconds, so a Computer's answer is polled for, never awaited in one call. A
 * read that fails on the way (a dropped connection, a gateway error) is asked again, not taken as
 * an answer. The deadline and the caller going away both end the wait as `onGiveUp`, which the
 * caller chooses for what not knowing means.
 */
export async function pollForAnswer<Read extends { status: string }>(options: {
  read(): Promise<Read>;
  /** What the wait ends as when no answer came by the deadline or the caller went away. */
  onGiveUp: Exclude<Read, { status: "pending" }>;
  signal: AbortSignal;
  /** The first wait, doubled on each read up to `intervalMs`, for an answer that is often quick. */
  firstIntervalMs?: number;
  intervalMs: number;
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Exclude<Read, { status: "pending" }>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUnlessAborted(options.signal);
  const deadline = now() + options.deadlineMs;
  let wait = options.firstIntervalMs ?? options.intervalMs;
  while (!options.signal.aborted && now() <= deadline) {
    try {
      const read = await options.read();
      if (read.status !== "pending") return read as Exclude<Read, { status: "pending" }>;
    } catch {
      // The next read asks again.
    }
    await sleep(wait);
    wait = Math.min(wait * 2, options.intervalMs);
  }
  return options.onGiveUp;
}
