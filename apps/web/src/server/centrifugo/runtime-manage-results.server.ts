import type { RedisClient } from "bun";
import {
  RUNTIME_MANAGE_RESULT_METHOD,
  decodeRuntimeManageResult,
  encodeRuntimeManageResult,
  type RuntimeManageRequest,
  type RuntimeManageResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameRuntimeManageScope,
  type RuntimeManageViewer,
} from "#src/server/computers/computer-runtime-manage.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

const PREFIX = "coforge:runtime-manage:v1";
const RUNTIME_MANAGE_PENDING_TTL_SECONDS = 660;
const RUNTIME_MANAGE_RESULT_TTL_SECONDS = 120;
type ResultsRedis = Pick<RedisClient, "get" | "set" | "send">;
type Pending = { request: RuntimeManageRequest; userId: string };

export class RedisRuntimeManageResults extends RedisPendingResults<
  RuntimeManageRequest,
  RuntimeManageResult,
  Pending
> {
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: PREFIX,
      pendingTtlSeconds: RUNTIME_MANAGE_PENDING_TTL_SECONDS,
      resultTtlSeconds: RUNTIME_MANAGE_RESULT_TTL_SECONDS,
      encode: encodeRuntimeManageResult,
      decode: decodeRuntimeManageResult,
      sameScope: sameRuntimeManageScope,
    });
  }
}

let singleton: RedisRuntimeManageResults | undefined;

export function getRuntimeManageResults() {
  return (singleton ??= new RedisRuntimeManageResults(
    openRedisClient(redisUrlFor("Runtime manage results")),
  ));
}

function isDaemonPrincipal(
  principal: RuntimeManageViewer & { agentId?: string; computerId?: string },
) {
  return Boolean(
    principal.userId && !principal.agentId && principal.workspaceId && principal.computerId,
  );
}

export function createRuntimeManageResultMethod(
  results: Pick<RedisRuntimeManageResults, "accept"> = getRuntimeManageResults(),
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const actor = principal as RuntimeManageViewer & { agentId?: string; computerId?: string };
    if (!isDaemonPrincipal(actor)) {
      return { code: 403, message: "Runtime manage result scope is not authorized" };
    }
    let result: RuntimeManageResult;
    try {
      result = decodeRuntimeManageResult(payload);
    } catch {
      return { code: 400, message: "Invalid runtime manage result" };
    }
    if (actor.workspaceId !== result.workspaceId || actor.computerId !== result.computerId) {
      return { code: 403, message: "Runtime manage result scope is not authorized" };
    }
    await results.accept(result);
    return new Uint8Array();
  };
}

export function runtimeManageResultMethods(enabled = true): Record<string, CentrifugoRpcMethod> {
  return {
    [RUNTIME_MANAGE_RESULT_METHOD]: enabled
      ? createRuntimeManageResultMethod()
      : () => ({ code: 503, message: "protocol method dependencies are unavailable" }),
  };
}
