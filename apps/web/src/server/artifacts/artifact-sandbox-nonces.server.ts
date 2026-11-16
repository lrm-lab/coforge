import { openRedisClient } from "#src/server/redis-client.server";

/**
 * Where a ticket's nonce is spent. `claim` is atomic: of any number of concurrent claims of one
 * nonce, exactly one gets true. A claim that cannot be made throws, and the ticket is then
 * refused: a single-use link never fails open.
 */
export type TicketNonces = {
  claim(nonce: string, ttlSeconds: number): Promise<boolean>;
};

type NonceRedis = {
  send(command: "SET", args: string[]): Promise<unknown>;
};

/** Redis `SET key 1 EX ttl NX`, the store of a deployment with Redis (the one-shot state the web
 * server already keeps there, rebuildable and short-lived). */
export class RedisTicketNonces implements TicketNonces {
  constructor(private readonly redis: NonceRedis) {}

  async claim(nonce: string, ttlSeconds: number): Promise<boolean> {
    const reply = await this.redis.send("SET", [
      `coforge:artifact-ticket:v1:${nonce}`,
      "1",
      "EX",
      String(Math.max(1, Math.ceil(ttlSeconds))),
      "NX",
    ]);
    return reply === "OK";
  }
}

/** The store of a process with no Redis (a local stack, tests): exact for one process only. */
export class MemoryTicketNonces implements TicketNonces {
  private readonly spent = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async claim(nonce: string, ttlSeconds: number): Promise<boolean> {
    const now = this.now();
    for (const [key, until] of this.spent) if (until <= now) this.spent.delete(key);
    if (this.spent.has(nonce)) return false;
    this.spent.set(nonce, now + ttlSeconds * 1000);
    return true;
  }
}

let production: TicketNonces | undefined;

export function productionTicketNonces(): TicketNonces {
  const url = Bun.env.REDIS_URL;
  production ??= url ? new RedisTicketNonces(openRedisClient(url)) : new MemoryTicketNonces();
  return production;
}
