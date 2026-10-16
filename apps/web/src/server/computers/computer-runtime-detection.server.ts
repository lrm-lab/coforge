import { RedisClient } from "bun";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { MODEL_CATALOG_REFRESH_TIMEOUT_MS } from "./computer-model-catalog-refresh.server";

type ComputerScope = { workspaceId: string; computerId: string };

/** As long as a rescan may wait for its answer, and a little more; then it reads as done. */
const TTL_SECONDS = String(Math.ceil(MODEL_CATALOG_REFRESH_TIMEOUT_MS / 1000) + 5);

/**
 * Whether a Computer is detecting its runtimes now: from a rescan the server asked for until that
 * rescan ends, as the reference Computer's "Detecting runtimes" reads. The runtimes it reported
 * last are still its confirmed ones meanwhile. The mark expires on its own, so a web process that
 * stops mid-rescan cannot leave a Computer detecting for good.
 */
export class RedisComputerRuntimeDetection {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      del(key: string): Promise<unknown>;
    },
  ) {}

  begin(scope: ComputerScope) {
    return this.redis.set(this.key(scope), "detecting", "EX", TTL_SECONDS);
  }

  end(scope: ComputerScope) {
    return this.redis.del(this.key(scope));
  }

  async detecting(scope: ComputerScope) {
    return (await this.redis.get(this.key(scope))) === "detecting";
  }

  private key({ workspaceId, computerId }: ComputerScope) {
    return workspaceRedisKey({ workspaceId, computerId, name: "runtime-detection", version: "v1" });
  }
}

let detection: RedisComputerRuntimeDetection | undefined;

export function getComputerRuntimeDetection() {
  detection ??= new RedisComputerRuntimeDetection(
    new RedisClient(redisUrlFor("Computer runtime detection")),
  );
  return detection;
}
