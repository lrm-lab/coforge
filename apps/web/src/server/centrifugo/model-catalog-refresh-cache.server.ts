import type { RedisClient } from "bun";
import { openRedisClient } from "#src/server/redis-client.server";
import {
  decodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
} from "@lrm/coforge-sdk/internal";
import { MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS } from "#src/server/computers/computer-model-catalog-refresh.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisPendingResults } from "./redis-pending-results.server";

export class RedisModelCatalogRefreshResults extends RedisPendingResults<
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse
> {
  constructor(redis: Pick<RedisClient, "get" | "set" | "send">) {
    super(redis, {
      prefix: "coforge:model-catalog-refresh:v1",
      pendingTtlSeconds: MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS,
      encode: encodeDaemonRuntimeProviderModelRefreshResponse,
      decode: decodeDaemonRuntimeProviderModelRefreshResponse,
      sameScope: (pending, result) =>
        pending.protocolMajor === result.protocolMajor &&
        pending.requestId === result.requestId &&
        pending.workspaceId === result.workspaceId &&
        pending.computerId === result.computerId,
    });
  }
}

let singleton: RedisModelCatalogRefreshResults | undefined;
export function getModelCatalogRefreshResults() {
  return (singleton ??= new RedisModelCatalogRefreshResults(
    openRedisClient(redisUrlFor("Model catalog refresh")),
  ));
}
