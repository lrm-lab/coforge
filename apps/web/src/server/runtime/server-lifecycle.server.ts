/**
 * What srvx waits when the process is told to stop (its `gracefulShutdown` default;
 * `SERVER_SHUTDOWN_TIMEOUT` seconds overrides it). srvx closes the HTTP server, which waits for
 * requests under way, and then leaves the process to end by itself. It never does while a timer or
 * a pooled connection is open, so Docker waited ten seconds and sent SIGKILL on every deploy.
 * https://srvx.h3.dev/guide/options#gracefulshutdown
 */
export const SERVER_SHUTDOWN_GRACE_MS = 5_000;

/** How far past srvx's own wait the backstop lets a stuck shutdown run before it ends the process. */
export const SERVER_SHUTDOWN_BACKSTOP_SLACK_MS = 1_000;

/** Exit status of a shutdown the backstop had to end; a clean shutdown exits 0. */
export const SERVER_SHUTDOWN_FORCED_EXIT_CODE = 1;

type Stop = () => void | Promise<void>;

const stops: Stop[] = [];
let installed = false;
let shutdownPromise: Promise<never> | undefined;

/**
 * Registers how to stop a timer or close a long-lived handle (a Redis client, the database pool)
 * when the process is told to stop. The module that starts the handle calls this where it starts
 * it, so nothing else needs to know the handle exists.
 */
export function onServerShutdown(stop: Stop): void {
  stops.push(stop);
}

function graceMs(env: NodeJS.ProcessEnv): number {
  const seconds = Number.parseInt(env.SERVER_SHUTDOWN_TIMEOUT ?? "", 10);
  return seconds > 0 ? seconds * 1_000 : SERVER_SHUTDOWN_GRACE_MS;
}

/** One shutdown for every signal: a second signal joins the first instead of running it again. */
function shutdown(env: NodeJS.ProcessEnv): Promise<never> {
  shutdownPromise ??= (async () => {
    const backstop = setTimeout(
      () => {
        console.error(JSON.stringify({ event: "server_lifecycle:shutdown_forced" }));
        process.exit(SERVER_SHUTDOWN_FORCED_EXIT_CODE);
      },
      graceMs(env) + SERVER_SHUTDOWN_BACKSTOP_SLACK_MS,
    );
    backstop.unref();
    await Promise.allSettled(stops.map(async (stop) => stop()));
    return process.exit(0);
  })();
  return shutdownPromise;
}

/**
 * Ends the process on SIGTERM or SIGINT once every registered stop has finished. A timer ends it
 * with a non-zero status a little after srvx's wait, so a handle that never closes cannot bring
 * the hang back, and a test can tell that apart from a clean exit.
 *
 * Call it once from the SSR entry, the environment where the registered handles live.
 */
export function installServerLifecycle(env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  installed = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(env));
}
