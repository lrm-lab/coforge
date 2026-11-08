import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerReleaseState } from "./computer-release-state.server";

let state: RedisComputerReleaseState | undefined;

export function getComputerReleaseState() {
  return (state ??= new RedisComputerReleaseState(
    openRedisClient(redisUrlFor("Computer release state")),
  ));
}
