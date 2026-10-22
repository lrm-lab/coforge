import { RedisClient } from "bun";

import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/** The one way the web server opens a Redis connection: it is closed when the process stops. */
export function openRedisClient(url: string): RedisClient {
  const client = new RedisClient(url);
  onServerShutdown(() => client.close());
  return client;
}
