import { RedisClient } from "bun";

import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/** Bun's largest accepted `maxRetries` (a uint32). */
const UNBOUNDED_RECONNECT_ATTEMPTS = 4_294_967_295;

/** How long a command waits for Redis's answer, which takes well under a millisecond. */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

/** How often a client checks its connection still answers, and keeps it seen while idle. */
export const REDIS_HEARTBEAT_MS = 30_000;

/** Commands with no effect, so one that failed on a lost connection is sent again, once. */
const READS = new Set(["get", "mget", "exists", "zrangebyscore", "zrange", "zscore", "ttl"]);

/** Passed through as they are: lifecycle calls, and a subscription, which waits for messages. */
const UNBOUNDED = new Set(["connect", "subscribe", "unsubscribe"]);

/** A command that got no answer in time; it is never sent later. */
export class RedisCommandTimeoutError extends Error {
  override name = "RedisCommandTimeoutError";
}

function lostConnection(error: unknown) {
  return (
    error instanceof RedisCommandTimeoutError ||
    (error as { code?: unknown } | null)?.code === "ERR_REDIS_CONNECTION_CLOSED"
  );
}

/**
 * The one way the web server opens a Redis connection: it is closed when the process stops.
 *
 * Bun gives up after `maxRetries` failed reconnects (default 20, about 20 s of outage) and the
 * client then fails every command for good, so the retry limit is raised to the maximum: a client
 * reconnects whenever Redis returns.
 *
 * Bun has no command timeout, and a connection a NAT dropped silently still says it is connected
 * while every command on it waits forever (task #348). So a command waits at most
 * `commandTimeoutMs` — for a connection, then for its answer — and one that ran out is never sent
 * after (Bun's own queue would send it once Redis returned, after its caller was told it failed).
 * A connection that says it is connected but did not answer, here or to the ping every
 * `heartbeatMs`, is closed and opened again; a read it failed is sent once more.
 */
export function openRedisClient(
  url: string,
  {
    commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
    heartbeatMs = REDIS_HEARTBEAT_MS,
  }: { commandTimeoutMs?: number; heartbeatMs?: number } = {},
): RedisClient {
  const client = new RedisClient(url, {
    maxRetries: UNBOUNDED_RECONNECT_ATTEMPTS,
    enableOfflineQueue: false,
  });
  let closed = false;
  const connected = () => {
    if (closed) return Promise.reject(new Error("Redis client is closed"));
    return client.connected ? Promise.resolve() : client.connect();
  };
  const stalled = () => {
    if (closed || !client.connected) return;
    console.warn(JSON.stringify({ event: "redis:connection_stalled" }));
    client.close();
    // Opened again now, not at the next command: a subscription must come back without one.
    client.connect().catch(() => {});
  };
  const bounded = <T>(send: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      let expired = false;
      let sent = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new RedisCommandTimeoutError(`Redis did not answer in ${commandTimeoutMs} ms`));
        // Only a connection that took the command and did not answer has stopped.
        if (sent) stalled();
      }, commandTimeoutMs);
      const settled = (finish: () => void) => {
        clearTimeout(timer);
        finish();
      };
      connected()
        .then(() => {
          if (expired) return undefined;
          sent = true;
          // Inside the chain: Bun refuses bad arguments by throwing, not by rejecting.
          return send();
        })
        .then(
          (value) => settled(() => resolve(value as T)),
          (error: unknown) => settled(() => reject(error)),
        );
    });
  const heartbeat = setInterval(() => {
    if (client.connected) bounded(() => client.send("PING", [])).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();
  const close = () => {
    closed = true;
    clearInterval(heartbeat);
    client.close();
  };
  onServerShutdown(close);
  const wrapped = new Map<string, unknown>();
  return new Proxy(client, {
    get(target, property) {
      if (property === "close") return close;
      const value: unknown = Reflect.get(target, property, target);
      // `onconnect` and the like are the caller's handlers, not commands.
      if (typeof value !== "function" || typeof property !== "string" || property.startsWith("on"))
        return value;
      let method = wrapped.get(property);
      if (method) return method;
      const run = (args: unknown[]) => value.apply(target, args) as Promise<unknown>;
      if (UNBOUNDED.has(property))
        method =
          property === "connect"
            ? value.bind(target)
            : (...args: unknown[]) => connected().then(() => run(args));
      else if (READS.has(property))
        method = (...args: unknown[]) =>
          bounded(() => run(args)).catch((error: unknown) => {
            if (!lostConnection(error)) throw error;
            return bounded(() => run(args));
          });
      else method = (...args: unknown[]) => bounded(() => run(args));
      wrapped.set(property, method);
      return method;
    },
    set: (target, property, value) => Reflect.set(target, property, value, target),
  });
}

/** What `subscribeAcrossReconnects` needs of a client. */
export type RedisSubscriber = {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  send(command: string, args: string[]): Promise<unknown>;
  onconnect: (() => void) | null;
};

/**
 * Subscribes `client` to `channel` for as long as it lives; the client serves this one
 * subscription. A new connection — Bun's reconnect, or `openRedisClient` replacing one that
 * stopped — starts with no subscriptions, and a message published meanwhile is lost: so each
 * connection subscribes again, then calls `onGap` for the caller to read what it may have missed.
 */
export async function subscribeAcrossReconnects(
  client: RedisSubscriber,
  channel: string,
  onMessage: (message: string) => void,
  onGap: () => void,
) {
  // Set first, so a connection replaced while subscribing is renewed too. Bun keeps the listener;
  // only the connection must be told the channel again.
  client.onconnect = () => {
    client.send("SUBSCRIBE", [channel]).then(onGap, () => {});
  };
  await client.subscribe(channel, onMessage);
}
