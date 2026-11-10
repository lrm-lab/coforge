import { openRedisClient } from "#src/server/redis-client.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS } from "./computer-model-catalog-refresh.server";

type ComputerScope = { workspaceId: string; computerId: string };

/** Shorter than the page's wait for a rescan, so the page has given up on none that still reads as
 * detecting; then it reads as done. */
const TTL_SECONDS = String(MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS);

// Deletes the mark only while it still names the request ending it, so a refresh that ends never
// ends another one still running on the Computer.
const END_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Whether a Computer is detecting its runtimes now: from a rescan the server asked for until its
 * result is stored, as the reference Computer's "Detecting runtimes" reads. The runtimes it
 * reported last are still its confirmed ones meanwhile. The mark names the request that set it and
 * only that request ends it; a request that begins while another is running takes the mark over
 * (the newest wins), so the Computer reads as detecting until the newest request ends. The mark
 * expires on its own, so a result that never arrives cannot leave a Computer detecting for good.
 */
export class RedisComputerRuntimeDetection {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      send(command: string, args: string[]): Promise<unknown>;
    },
  ) {}

  begin(scope: ComputerScope, requestId: string) {
    return this.redis.set(this.key(scope), requestId, "EX", TTL_SECONDS);
  }

  end(scope: ComputerScope, requestId: string) {
    return this.redis.send("EVAL", [END_IF_OWNER, "1", this.key(scope), requestId]);
  }

  async detecting(scope: ComputerScope) {
    return (await this.redis.get(this.key(scope))) !== null;
  }

  private key({ workspaceId, computerId }: ComputerScope) {
    return workspaceRedisKey({ workspaceId, computerId, name: "runtime-detection", version: "v1" });
  }
}

let detection: RedisComputerRuntimeDetection | undefined;

export function getComputerRuntimeDetection() {
  detection ??= new RedisComputerRuntimeDetection(
    openRedisClient(redisUrlFor("Computer runtime detection")),
  );
  return detection;
}
