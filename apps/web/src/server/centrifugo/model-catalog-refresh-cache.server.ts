import { RedisClient } from "bun";
import {
  decodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
} from "@lrm/coforge-sdk/internal";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisPendingResults } from "./redis-pending-results.server";

export class RedisModelCatalogRefreshResults extends RedisPendingResults<
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse
> {
  constructor(redis: Pick<RedisClient, "get" | "set" | "send">) {
    super(redis, {
      prefix: "coforge:model-catalog-refresh:v1",
      pendingTtlSeconds: 60,
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
    new RedisClient(redisUrlFor("Model catalog refresh")),
  ));
}
