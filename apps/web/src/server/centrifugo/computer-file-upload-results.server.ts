import type { RedisClient } from "bun";
import {
  decodeComputerFilePullResult,
  encodeComputerFilePullResult,
  COMPUTER_FILE_PULL_RESULT_METHOD,
  type ComputerFilePullRequest,
  type ComputerFilePullResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameComputerFilePullScope,
  type ComputerFilePullResults,
  type PendingComputerFilePull,
} from "#src/server/computers/computer-file-upload.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

const PREFIX = "coforge:computer-file-upload:v1:pull";
type ResultsRedis = Pick<RedisClient, "get" | "set" | "send">;

export class RedisComputerFilePullResults
  extends RedisPendingResults<
    ComputerFilePullRequest,
    ComputerFilePullResult,
    PendingComputerFilePull
  >
  implements ComputerFilePullResults
{
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: PREFIX,
      // Large files can take a while to land; keep the pending scope for the pull wait.
      pendingTtlSeconds: 660,
      resultTtlSeconds: 60,
      encode: encodeComputerFilePullResult,
      decode: decodeComputerFilePullResult,
      sameScope: sameComputerFilePullScope,
    });
  }
}

let singleton: RedisComputerFilePullResults | undefined;

export function getComputerFilePullResults() {
  return (singleton ??= new RedisComputerFilePullResults(
    openRedisClient(redisUrlFor("Computer file upload pull results")),
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

export function computerFilePullResultMethods(enabled = true): Record<string, CentrifugoRpcMethod> {
  const unavailable: CentrifugoRpcMethod = () => ({
    code: 503,
    message: "protocol method dependencies are unavailable",
  });
  return {
    [COMPUTER_FILE_PULL_RESULT_METHOD]: enabled
      ? createComputerFilePullResultMethod()
      : unavailable,
  };
}

export function createComputerFilePullResultMethod(
  results?: Pick<RedisComputerFilePullResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeComputerFilePullResult(payload);
    if (!authorized(principal, result))
      return { code: 403, message: "Computer file pull result scope is not authorized" };
    await (results ?? getComputerFilePullResults()).accept(result);
    return new Uint8Array();
  };
}
