import { AsyncLocalStorage } from "node:async_hooks";
import { errorType } from "#src/server/errors/error-type.server";

/** A server function call slower than this is a warning, and is reported while it still runs. */
export const SLOW_SERVER_FN_MS = 3_000;

type Log = Pick<Console, "info" | "warn">;

/** The call in progress: a function that failed answers with its error as the result, often with
 * a success status, so `recordServerFnError` marks it here. */
const calls = new AsyncLocalStorage<{ error?: string }>();

/** Marks the server function call in progress as failed unexpectedly, with what it threw. */
export function recordServerFnError(error: unknown) {
  const call = calls.getStore();
  if (call) call.error = errorType(error);
}

/**
 * One log line per server function call (task #348): its id (the hash in `/_serverFn/<id>`),
 * method, status and how long until its response existed — for a streamed reply, not its last
 * byte. A slow, failed or abandoned call is a warning, and one still running at `slowMs` is
 * reported then too, so a call that never finishes leaves a line. `request_id` matches Caddy's
 * access log when the proxy sets `X-Request-Id`.
 */
export async function withServerFnLog<T extends { response: Response }>(
  request: Request,
  next: () => Promise<T> | T,
  {
    log = console,
    now = () => performance.now(),
    slowMs = SLOW_SERVER_FN_MS,
  }: { log?: Log; now?: () => number; slowMs?: number } = {},
): Promise<T> {
  const base = process.env.TSS_SERVER_FN_BASE ?? "/_serverFn/";
  const fields = {
    fn: new URL(request.url).pathname.slice(base.length).split("/")[0],
    method: request.method,
    request_id: request.headers.get("x-request-id") ?? undefined,
  };
  const startedAt = now();
  const took = () => Math.round(now() - startedAt);
  const running = setTimeout(
    () => log.warn(JSON.stringify({ event: "server_fn.running", ...fields, duration_ms: took() })),
    slowMs,
  );
  const call: { error?: string } = {};
  try {
    const result = await calls.run(call, next);
    const durationMs = took();
    const { status } = result.response;
    const level = durationMs >= slowMs || status >= 500 || call.error ? "warn" : "info";
    log[level](
      JSON.stringify({
        event: "server_fn.finished",
        ...fields,
        status,
        duration_ms: durationMs,
        error_type: call.error,
      }),
    );
    return result;
  } catch (error) {
    log.warn(
      JSON.stringify({
        event: request.signal.aborted ? "server_fn.aborted" : "server_fn.failed",
        ...fields,
        duration_ms: took(),
        error_type: errorType(error),
      }),
    );
    throw error;
  } finally {
    clearTimeout(running);
  }
}
