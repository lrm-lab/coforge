import type { RedisClient } from "bun";
import { openRedisClient } from "#src/server/redis-client.server";
import {
  decodeDaemonRuntimeCommandCodeEffortReadResponse,
  encodeDaemonRuntimeCommandCodeEffortReadResponse,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeCommandCodeEffortReadResponse,
} from "@lrm/coforge-sdk/internal";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisPendingResults } from "./redis-pending-results.server";

export class RedisCommandCodeEffortResults extends RedisPendingResults<
  DaemonRuntimeCommandCodeEffortReadRequest,
  DaemonRuntimeCommandCodeEffortReadResponse
> {
  constructor(redis: Pick<RedisClient, "get" | "set" | "send">) {
    super(redis, {
      prefix: "coforge:command-code-effort:v1",
      pendingTtlSeconds: 60,
      encode: encodeDaemonRuntimeCommandCodeEffortReadResponse,
      decode: decodeDaemonRuntimeCommandCodeEffortReadResponse,
      sameScope: (pending, result) =>
        pending.protocolMajor === result.protocolMajor &&
        pending.requestId === result.requestId &&
        pending.workspaceId === result.workspaceId &&
        pending.computerId === result.computerId,
    });
  }
}

let singleton: RedisCommandCodeEffortResults | undefined;
export function getCommandCodeEffortResults() {
  return (singleton ??= new RedisCommandCodeEffortResults(
    openRedisClient(redisUrlFor("Command Code effort read")),
  ));
}
