import { workspaceRedisKey } from "#src/server/redis-keys.server";

/** How long a capability holds without a heartbeat: a Computer gone this long is not counted. */
const TTL_SECONDS = "90";

/**
 * Whether a Computer's daemon supports one capability, as its last ready said. The ready records
 * it, and each status heartbeat keeps a supported one alive, so support also means the Computer
 * has been connected within the last 90 seconds. An unsupported one is never kept alive, so after
 * a while it reads the same as a Computer never seen.
 */
export class RedisComputerCapabilityLease {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
    },
    private readonly capability: string,
    private readonly name: string,
  ) {}

  record(workspaceId: string, computerId: string, capabilities: readonly string[]) {
    return this.redis.set(
      this.key(workspaceId, computerId),
      capabilities.includes(this.capability) ? "supported" : "unsupported",
      "EX",
      TTL_SECONDS,
    );
  }

  async supports(workspaceId: string, computerId: string) {
    return (await this.redis.get(this.key(workspaceId, computerId))) === "supported";
  }

  async refresh(workspaceId: string, computerId: string) {
    const key = this.key(workspaceId, computerId);
    if ((await this.redis.get(key)) === "supported")
      await this.redis.set(key, "supported", "EX", TTL_SECONDS);
  }

  private key(workspaceId: string, computerId: string) {
    return workspaceRedisKey({ workspaceId, computerId, name: this.name, version: "v1" });
  }
}
