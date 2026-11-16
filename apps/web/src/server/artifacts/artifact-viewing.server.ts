import { openRedisClient } from "#src/server/redis-client.server";

export const VIEWING_TTL_MS = 45_000;

export type ArtifactViewing = {
  mark(artifactId: string, userId: string): Promise<void>;
  now(artifactId: string): Promise<string[]>;
};

type ViewingRedis = {
  send(command: string, args: string[]): Promise<unknown>;
};

const HEARTBEAT = `
redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
redis.call("PEXPIRE", KEYS[1], ARGV[3])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[4])
return 1`;

const key = (artifactId: string) => `coforge:artifact-viewing:v1:${artifactId}`;

export class RedisArtifactViewing implements ArtifactViewing {
  constructor(
    private readonly redis: ViewingRedis,
    private readonly clock: () => number = Date.now,
  ) {}

  async mark(artifactId: string, userId: string) {
    const at = this.clock();
    await this.redis.send("EVAL", [
      HEARTBEAT,
      "1",
      key(artifactId),
      String(at + VIEWING_TTL_MS),
      userId,
      String(VIEWING_TTL_MS * 2),
      String(at),
    ]);
  }

  async now(artifactId: string) {
    const reply = await this.redis.send("ZRANGEBYSCORE", [
      key(artifactId),
      String(this.clock()),
      "+inf",
    ]);
    return Array.isArray(reply) ? reply.map(String) : [];
  }
}

export class MemoryArtifactViewing implements ArtifactViewing {
  private readonly until = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  async mark(artifactId: string, userId: string) {
    this.until.set(`${artifactId}:${userId}`, this.clock() + VIEWING_TTL_MS);
  }

  async now(artifactId: string) {
    const now = this.clock();
    const prefix = `${artifactId}:`;
    return [...this.until]
      .filter(([entry, until]) => entry.startsWith(prefix) && until > now)
      .map(([entry]) => entry.slice(prefix.length));
  }
}

let production: ArtifactViewing | undefined;

export function productionArtifactViewing(): ArtifactViewing {
  const url = Bun.env.REDIS_URL;
  production ??= url ? new RedisArtifactViewing(openRedisClient(url)) : new MemoryArtifactViewing();
  return production;
}
