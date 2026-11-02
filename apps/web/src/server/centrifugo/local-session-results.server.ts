import type { RedisClient } from "bun";
import {
  decodeLocalSessionExcerptResult,
  decodeLocalSessionSearchResult,
  encodeLocalSessionExcerptResult,
  encodeLocalSessionSearchResult,
  LOCAL_SESSION_EXCERPT_RESULT_METHOD,
  LOCAL_SESSION_SEARCH_RESULT_METHOD,
  type LocalSessionExcerptRequest,
  type LocalSessionExcerptResult,
  type LocalSessionSearchRequest,
  type LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameLocalSessionExcerptScope,
  sameLocalSessionSearchScope,
  type LocalSessionExcerptResults,
  type LocalSessionSearchResults,
  type PendingLocalSessionExcerpt,
  type PendingLocalSessionSearch,
} from "#src/server/computers/computer-local-sessions.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

const PREFIX = "coforge:local-session-handoff:v1";
type ResultsRedis = Pick<RedisClient, "get" | "set" | "send">;

export class RedisLocalSessionSearchResults
  extends RedisPendingResults<
    LocalSessionSearchRequest,
    LocalSessionSearchResult,
    PendingLocalSessionSearch
  >
  implements LocalSessionSearchResults
{
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: `${PREFIX}:search`,
      pendingTtlSeconds: 15,
      resultTtlSeconds: 15,
      encode: encodeLocalSessionSearchResult,
      decode: decodeLocalSessionSearchResult,
      sameScope: sameLocalSessionSearchScope,
    });
  }
}

export class RedisLocalSessionExcerptResults
  extends RedisPendingResults<
    LocalSessionExcerptRequest,
    LocalSessionExcerptResult,
    PendingLocalSessionExcerpt
  >
  implements LocalSessionExcerptResults
{
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: `${PREFIX}:excerpt`,
      pendingTtlSeconds: 15,
      resultTtlSeconds: 15,
      encode: encodeLocalSessionExcerptResult,
      decode: decodeLocalSessionExcerptResult,
      sameScope: sameLocalSessionExcerptScope,
    });
  }
}

let searchSingleton: RedisLocalSessionSearchResults | undefined;
let excerptSingleton: RedisLocalSessionExcerptResults | undefined;

export function getLocalSessionSearchResults() {
  return (searchSingleton ??= new RedisLocalSessionSearchResults(
    openRedisClient(redisUrlFor("Local session handoff queries")),
  ));
}

export function getLocalSessionExcerptResults() {
  return (excerptSingleton ??= new RedisLocalSessionExcerptResults(
    openRedisClient(redisUrlFor("Local session handoff queries")),
  ));
}

function authorized(
  principal: { userId?: string; agentId?: string; workspaceId?: string; computerId?: string },
  result: { workspaceId: string; computerId: string },
) {
  return (
    Boolean(principal.userId) &&
    !principal.agentId &&
    principal.workspaceId === result.workspaceId &&
    principal.computerId === result.computerId
  );
}

export function localSessionResultMethods(enabled = true): Record<string, CentrifugoRpcMethod> {
  const unavailable: CentrifugoRpcMethod = () => ({
    code: 503,
    message: "protocol method dependencies are unavailable",
  });
  return {
    [LOCAL_SESSION_SEARCH_RESULT_METHOD]: enabled
      ? createLocalSessionSearchResultMethod()
      : unavailable,
    [LOCAL_SESSION_EXCERPT_RESULT_METHOD]: enabled
      ? createLocalSessionExcerptResultMethod()
      : unavailable,
  };
}

export function createLocalSessionSearchResultMethod(
  results?: Pick<RedisLocalSessionSearchResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeLocalSessionSearchResult(payload);
    if (!authorized(principal, result))
      return { code: 403, message: "Local session search result scope is not authorized" };
    await (results ?? getLocalSessionSearchResults()).accept(result);
    return new Uint8Array();
  };
}

export function createLocalSessionExcerptResultMethod(
  results?: Pick<RedisLocalSessionExcerptResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeLocalSessionExcerptResult(payload);
    if (!authorized(principal, result))
      return { code: 403, message: "Local session excerpt result scope is not authorized" };
    await (results ?? getLocalSessionExcerptResults()).accept(result);
    return new Uint8Array();
  };
}
