import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "connection"]);

/**
 * Centrifugo answers a proxied RPC it could not forward with `temporary: true` (code 100, "internal
 * server error"); the same request succeeds once the Web container is back. These delays cross a
 * deploy's ~1s blip without holding a launch for long.
 */
export const TEMPORARY_RPC_RETRY_DELAYS_MS = [
  250, 500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const;

/** Whether a failed RPC is the server's "try again" answer rather than a refusal. */
export function isTemporaryRpcError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { temporary?: unknown }).temporary === true
  );
}

/**
 * Runs an RPC that the server may answer `temporary: true`, retrying it on that bounded backoff.
 * Anything else — including the last temporary failure once the delays are spent — is thrown to the
 * caller, which reports it as before.
 */
export async function retryTemporaryRpc(
  work: () => Promise<void>,
  options: {
    delays?: readonly number[];
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const delays = options.delays ?? TEMPORARY_RPC_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((delayMs: number) => Bun.sleep(delayMs));
  for (let attempt = 0; ; attempt++) {
    try {
      await work();
      return;
    } catch (error) {
      if (!isTemporaryRpcError(error) || attempt >= delays.length) throw error;
      const delayMs = delays[attempt]!;
      logger.warning("Daemon RPC failed temporarily; retrying", {
        event: "daemon_connection:rpc_retry",
        attempt: attempt + 1,
        delay_ms: delayMs,
        error_code:
          typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : undefined,
      });
      options.onRetry?.(attempt + 1, delayMs, error);
      await sleep(delayMs);
    }
  }
}
