import { workspaceRedisKey } from "#src/server/redis-keys.server";

/** How long a capability holds without a heartbeat: a Computer gone this long is not counted. */
const TTL_SECONDS = "90";
const RECORD_NEWER = `
local current = redis.call("GET", KEYS[1])
local candidate = cjson.decode(ARGV[1])
if current then
  local ok, existing = pcall(cjson.decode, current)
  if ok and type(existing.startedAt) == "number" then
    if existing.startedAt > candidate.startedAt then return 0 end
    if existing.startedAt == candidate.startedAt and existing.workerInstanceId ~= candidate.workerInstanceId then return 0 end
  end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return 1`;

type CapabilityIdentity = { workerInstanceId: string; startedAt: number };
type CapabilityValue = CapabilityIdentity & { state: "supported" | "unsupported" };

/**
 * Whether a Computer's daemon supports one capability, as its last accepted ready said. The ready
 * records it, and each status heartbeat keeps a supported one alive. A stale worker cannot replace
 * a newer worker's value even when their ready requests overlap.
 */
export class RedisComputerCapabilityLease {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      send(command: "EVAL", args: string[]): Promise<unknown>;
    },
    private readonly capability: string,
    private readonly name: string,
  ) {}

  record(
    workspaceId: string,
    computerId: string,
    capabilities: readonly string[],
    identity?: CapabilityIdentity,
  ) {
    const state = capabilities.includes(this.capability) ? "supported" : "unsupported";
    const key = this.key(workspaceId, computerId);
    if (!identity) return this.redis.set(key, state, "EX", TTL_SECONDS);
    const value: CapabilityValue = {
      ...identity,
      state,
    };
    return this.redis.send("EVAL", [RECORD_NEWER, "1", key, JSON.stringify(value), TTL_SECONDS]);
  }

  async supports(workspaceId: string, computerId: string) {
    return (
      this.read(await this.redis.get(this.key(workspaceId, computerId)))?.state === "supported"
    );
  }

  async refresh(workspaceId: string, computerId: string) {
    const key = this.key(workspaceId, computerId);
    const raw = await this.redis.get(key);
    if (this.read(raw)?.state === "supported") await this.redis.set(key, raw!, "EX", TTL_SECONDS);
  }

  private read(raw: string | null): CapabilityValue | undefined {
    if (!raw) return;
    if (raw === "supported" || raw === "unsupported")
      return { state: raw, workerInstanceId: "", startedAt: 0 };
    try {
      const value = JSON.parse(raw) as Partial<CapabilityValue>;
      if (
        (value.state === "supported" || value.state === "unsupported") &&
        typeof value.workerInstanceId === "string" &&
        typeof value.startedAt === "number"
      )
        return value as CapabilityValue;
    } catch {
      // Values from a pre-fence server expire instead of becoming current-worker evidence.
    }
  }

  private key(workspaceId: string, computerId: string) {
    return workspaceRedisKey({ workspaceId, computerId, name: this.name, version: "v1" });
  }
}
