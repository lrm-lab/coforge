import { openRedisClient } from "#src/server/redis-client.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS } from "./computer-model-catalog-refresh.server";

type ComputerScope = { workspaceId: string; computerId: string };

/** Shorter than the page's wait for a rescan, so the page has given up on none that still reads as
 * detecting; then it reads as done. */
const TTL_SECONDS = String(MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS);

// Adds this scan to the mark and restarts its expiry, so scans that overlap on one Computer all
// stay named in it.
const BEGIN = `redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1`;

// Removes only this scan, and the mark with the last one: a scan that ends never ends another one
// still running on the Computer, whichever of the two started later.
const END_IF_NAMED = `redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 0 then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Whether a Computer is detecting its runtimes now: from a rescan the server asked for until its
 * result is stored, as the reference Computer's "Detecting runtimes" reads. The runtimes it
 * reported last are still its confirmed ones meanwhile. The mark names every scan still running on
 * the Computer, so two that overlap read as detecting until both end, in either order. The mark
 * expires on its own, so a scan whose result never arrives cannot leave a Computer detecting for
 * good.
 */
export class RedisComputerRuntimeDetection {
  constructor(
    private readonly redis: { send(command: string, args: string[]): Promise<unknown> },
  ) {}

  begin(scope: ComputerScope, requestId: string) {
    return this.redis.send("EVAL", [BEGIN, "1", this.key(scope), requestId, TTL_SECONDS]);
  }

  end(scope: ComputerScope, requestId: string) {
    return this.redis.send("EVAL", [END_IF_NAMED, "1", this.key(scope), requestId]);
  }

  async detecting(scope: ComputerScope) {
    return Number(await this.redis.send("SCARD", [this.key(scope)])) > 0;
  }

  private key({ workspaceId, computerId }: ComputerScope) {
    return workspaceRedisKey({ workspaceId, computerId, name: "runtime-detection", version: "v2" });
  }
}

let detection: RedisComputerRuntimeDetection | undefined;

export function getComputerRuntimeDetection() {
  detection ??= new RedisComputerRuntimeDetection(
    openRedisClient(redisUrlFor("Computer runtime detection")),
  );
  return detection;
}
