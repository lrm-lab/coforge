import { afterEach, expect, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import {
  openRedisClient,
  RedisCommandTimeoutError,
  subscribeAcrossReconnects,
} from "#src/server/redis-client.server";
import { freezableProxy } from "./helpers/freezable-proxy";

/**
 * A Redis connection that stops answering while it still says it is connected — what a NAT
 * silently dropping an idle connection leaves behind (task #348) — costs a command at most the
 * client's limit, and a subscription comes back on the new connection, telling its caller what it
 * may have missed. Redis is reached through `freezableProxy`.
 *
 * Skipped unless `CHANNEL_TEST_REDIS_URL` points at a scratch Redis.
 */
const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
const LIMIT_MS = 300;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function throughProxy(heartbeatMs = 60_000) {
  const proxy = freezableProxy(new URL(redisUrl!));
  const client = openRedisClient(proxy.url, { commandTimeoutMs: LIMIT_MS, heartbeatMs });
  const direct = new RedisClient(redisUrl!);
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  cleanup = () => {
    warnings.mockRestore();
    client.close();
    direct.close();
    proxy.stop();
  };
  return { proxy, client, direct, key: `redis-stall:${crypto.randomUUID()}` };
}

const elapsed = async <T>(run: () => Promise<T>) => {
  const startedAt = performance.now();
  const outcome = await run().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { ...outcome, ms: performance.now() - startedAt };
};

test.skipIf(!redisUrl)(
  "a read on a connection that stopped answering is sent again on a new one",
  async () => {
    const { proxy, client, direct, key } = throughProxy();
    await direct.set(key, "kept");
    expect(await client.get(key)).toBe("kept");
    proxy.freeze();

    const read = await elapsed(() => client.get(key));
    expect(read).toMatchObject({ value: "kept" });
    expect(read.ms).toBeLessThan(LIMIT_MS * 3);
    expect(proxy.opened()).toBe(2);
  },
);

test.skipIf(!redisUrl)(
  "a write on a connection that stopped answering fails within the limit, and the client recovers",
  async () => {
    const { proxy, client, direct, key } = throughProxy();
    await client.get(key);
    proxy.freeze();

    const write = await elapsed(() => client.set(key, "once"));
    expect(write).toMatchObject({ error: expect.any(RedisCommandTimeoutError) });
    expect(write.ms).toBeLessThan(LIMIT_MS * 2);
    // Not sent again: the frozen connection swallowed it, and the new one never saw it.
    expect(await direct.get(key)).toBeNull();
    await client.set(key, "after");
    expect(await direct.get(key)).toBe("after");
  },
);

test.skipIf(!redisUrl)(
  "a command Bun refuses fails at once, and the connection stays",
  async () => {
    const { proxy, client } = throughProxy();
    await client.get("warm");
    const refused = await elapsed(() => client.set("key", undefined as never));
    expect(refused).toHaveProperty("error");
    expect(refused.ms).toBeLessThan(LIMIT_MS);
    await Bun.sleep(LIMIT_MS * 1.5);
    expect(await client.get("warm")).toBeNull();
    expect(proxy.opened()).toBe(1);
  },
);

test.skipIf(!redisUrl)(
  "a write that ran out while Redis was down is never sent once it is back",
  async () => {
    const { proxy, client, direct, key } = throughProxy();
    await client.get(key);
    proxy.cut();
    for (let tries = 0; tries < 40 && client.connected; tries += 1) await Bun.sleep(25);

    const write = await elapsed(() => client.set(key, "late"));
    expect(write).toMatchObject({ error: expect.any(RedisCommandTimeoutError) });
    proxy.restore();
    for (let tries = 0; tries < 40 && !client.connected; tries += 1) await Bun.sleep(50);
    expect(await client.get(key)).toBeNull();
    expect(await direct.get(key)).toBeNull();
  },
);

test.skipIf(!redisUrl)(
  "a subscription on an idle connection that stopped comes back, and its caller hears of the gap",
  async () => {
    const { proxy, client, direct, key } = throughProxy(100);
    const messages: string[] = [];
    let gaps = 0;
    await subscribeAcrossReconnects(
      client,
      key,
      (message) => messages.push(message),
      () => (gaps += 1),
    );
    const delivered = async (message: string) => {
      for (let tries = 0; tries < 40 && !messages.includes(message); tries += 1) {
        await direct.publish(key, message);
        await Bun.sleep(50);
      }
    };
    await delivered("before");
    proxy.freeze();
    await direct.publish(key, "lost");

    // The heartbeat finds the connection stopped, a new one subscribes again.
    for (let tries = 0; tries < 40 && gaps === 0; tries += 1) await Bun.sleep(50);
    expect(gaps).toBe(1);
    await delivered("after");
    expect(messages).not.toContain("lost");
    expect(messages).toContain("after");
  },
);
