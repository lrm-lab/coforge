import { RedisClient } from "bun";

import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/** Bun's largest accepted `maxRetries` (a uint32). */
const UNBOUNDED_RECONNECT_ATTEMPTS = 4_294_967_295;

/**
 * The one way the web server opens a Redis connection: it is closed when the process stops.
 *
 * Bun gives up after `maxRetries` failed reconnects (default 20, about 20 s of outage) and the
 * client then fails every command for good, so the retry limit is raised to the maximum: a client
 * reconnects whenever Redis returns.
 */
export function openRedisClient(url: string): RedisClient {
  const client = new RedisClient(url, { maxRetries: UNBOUNDED_RECONNECT_ATTEMPTS });
  onServerShutdown(() => client.close());
  return client;
}
