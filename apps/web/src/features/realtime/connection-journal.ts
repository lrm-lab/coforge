/**
 * One console line for each change of the page's realtime connection: why it dropped, each error on
 * the way back (the client's own, a failed token fetch included), how long the reconnect took, and a
 * connection token fetch that is slow.
 * Centrifugo logs only the commands it rejects, so a connection that never hears back from it (a
 * proxy swallowing the server's frames, task #322) is visible from the browser alone.
 */

/** A connection token fetch slower than this is reported. */
const SLOW_TOKEN_MS = 1_000;

type Reason = { code: number; reason: string };
type ClientError = { type: string; error: { code: number; message: string } };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function createConnectionJournal({
  now,
  log,
}: {
  now: () => number;
  log: Pick<Console, "info" | "warn">;
}) {
  let reconnect: { since: number; errors: number } | undefined;
  return {
    connecting: ({ code, reason }: Reason) => {
      reconnect ??= { since: now(), errors: 0 };
      log.info(`realtime connecting: ${code} ${reason}`);
    },
    error: ({ type, error }: ClientError) => {
      if (reconnect) reconnect.errors += 1;
      log.warn(`realtime ${type} error: ${error.code} ${error.message}`);
    },
    connected: () => {
      if (reconnect)
        log.info(
          `realtime connected after ${seconds(now() - reconnect.since)}, ${reconnect.errors} errors`,
        );
      reconnect = undefined;
    },
    disconnected: ({ code, reason }: Reason) => {
      reconnect = undefined;
      // Code 0 is the page's own disconnect: a wake's reconnect, or leaving the Workspace.
      log[code === 0 ? "info" : "warn"](`realtime disconnected: ${code} ${reason}`);
    },
    /** `fetchToken`, reporting a slow fetch. A failed one is the client's `connectToken` error. */
    timeToken:
      <T>(fetchToken: () => Promise<T>) =>
      async () => {
        const startedAt = now();
        const token = await fetchToken();
        const tookMs = now() - startedAt;
        if (tookMs >= SLOW_TOKEN_MS) log.warn(`realtime connection token took ${seconds(tookMs)}`);
        return token;
      },
  };
}
