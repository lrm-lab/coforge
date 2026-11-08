import { RELEASE_CHANNEL_CAPABILITY, isValidReleaseVersion } from "@lrm/coforge-sdk/internal";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

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
const REFRESH_IF_CURRENT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0`;

export type ServerReleaseChannel = "latest" | "alpha" | `pinned:${string}`;
type ReleaseIdentity = { workerInstanceId: string; startedAt: number };
type ReleaseState = ReleaseIdentity & {
  supported: boolean;
  channel?: ServerReleaseChannel;
};

function parseChannel(raw: string | undefined): ServerReleaseChannel | undefined {
  const value = raw?.trim();
  if (!value || value === "latest" || value === "alpha")
    return value as ServerReleaseChannel | undefined;
  if (!value.startsWith("pinned:")) return undefined;
  const version = value.slice("pinned:".length);
  return isValidReleaseVersion(version) ? `pinned:${version}` : undefined;
}

/** Ephemeral, identity-fenced release metadata reported by a Computer's ready handshake. */
export class RedisComputerReleaseState {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      mget(...keys: string[]): Promise<Array<string | null>>;
      send(command: "EVAL", args: string[]): Promise<unknown>;
    },
  ) {}

  record(
    workspaceId: string,
    computerId: string,
    channel: string | undefined,
    capabilities: readonly string[],
    identity: ReleaseIdentity,
  ) {
    const parsed = parseChannel(channel);
    const value: ReleaseState = {
      ...identity,
      supported: capabilities.includes(RELEASE_CHANNEL_CAPABILITY) && parsed !== undefined,
      ...(parsed ? { channel: parsed } : {}),
    };
    return this.redis.send("EVAL", [
      RECORD_NEWER,
      "1",
      this.key(workspaceId, computerId),
      JSON.stringify(value),
      TTL_SECONDS,
    ]);
  }

  async get(workspaceId: string, computerId: string): Promise<ServerReleaseChannel | undefined> {
    const raw = await this.redis.get(this.key(workspaceId, computerId));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<ReleaseState>;
      if (value.supported !== true || typeof value.channel !== "string") return undefined;
      return parseChannel(value.channel);
    } catch {
      return undefined;
    }
  }

  async getMany(scopes: readonly { workspaceId: string; computerId: string }[]) {
    if (scopes.length === 0) return [];
    const values = await this.redis.mget(
      ...scopes.map((scope) => this.key(scope.workspaceId, scope.computerId)),
    );
    return values.map((raw) => {
      if (!raw) return undefined;
      try {
        const value = JSON.parse(raw) as Partial<ReleaseState>;
        if (value.supported !== true || typeof value.channel !== "string") return undefined;
        return parseChannel(value.channel);
      } catch {
        return undefined;
      }
    });
  }

  async refresh(
    workspaceId: string,
    computerId: string,
    identity?: ReleaseIdentity,
  ): Promise<void> {
    const key = this.key(workspaceId, computerId);
    const raw = await this.redis.get(key);
    if (!raw) return;
    if (identity) {
      try {
        const value = JSON.parse(raw) as Partial<ReleaseState>;
        if (
          value.workerInstanceId !== identity.workerInstanceId ||
          value.startedAt !== identity.startedAt
        )
          return;
      } catch {
        return;
      }
    }
    await this.redis.send("EVAL", [REFRESH_IF_CURRENT, "1", key, raw, TTL_SECONDS]);
  }

  private key(workspaceId: string, computerId: string) {
    return workspaceRedisKey({
      workspaceId,
      computerId,
      name: "computer-release-state",
      version: "v1",
    });
  }
}
