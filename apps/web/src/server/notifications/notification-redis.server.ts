import { openRedisClient } from "#src/server/redis-client.server";
import { RedisComputerActivity } from "./computer-activity.server";
import { RedisDeferredPushes } from "./deferred-mobile-pushes.server";

/**
 * The notification settings' short-lived Redis state (task #467): who is at a computer, and the
 * phone notifications waiting for them to leave it. One client per process, opened at first use.
 * Without `REDIS_URL` there is neither: every device is sent at once, as before the settings.
 */
let client: ReturnType<typeof openRedisClient> | undefined;

function redis() {
  const url = Bun.env.REDIS_URL;
  if (!url) return undefined;
  return (client ??= openRedisClient(url));
}

export function computerActivity(): RedisComputerActivity | undefined {
  const connection = redis();
  return connection && new RedisComputerActivity(connection);
}

export function deferredMobilePushes(): RedisDeferredPushes | undefined {
  const connection = redis();
  return connection && new RedisDeferredPushes(connection);
}
