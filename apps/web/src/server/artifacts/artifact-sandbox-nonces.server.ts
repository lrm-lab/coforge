import { openRedisClient } from "#src/server/redis-client.server";

export type TicketNonces = {
  claim(nonce: string, ttlSeconds: number): Promise<boolean>;
};

type NonceRedis = {
  send(command: "SET", args: string[]): Promise<unknown>;
};

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
