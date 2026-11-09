import type { RedisClient } from "bun";
import { openRedisClient } from "#src/server/redis-client.server";
import {
  decodeDaemonRuntimeResetCreditConsumeResponse,
  encodeDaemonRuntimeResetCreditConsumeResponse,
  type DaemonRuntimeResetCreditConsumeRequest,
  type DaemonRuntimeResetCreditConsumeResponse,
} from "@lrm/coforge-sdk/internal";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisPendingResults } from "./redis-pending-results.server";

/** The pending request outlives the Computer's worst case (about 90 seconds), so a slow answer is
 * still taken. */
export const RESET_CREDIT_PENDING_TTL_SECONDS = 120;
/** The Computer's reply is kept this long for the page to poll for it, and is read more than once
 * (a poll that failed on the way back asks again), so it expires rather than being cleared. */
export const RESET_CREDIT_RESULT_TTL_SECONDS = 300;

export class RedisResetCreditResults extends RedisPendingResults<
  DaemonRuntimeResetCreditConsumeRequest,
  DaemonRuntimeResetCreditConsumeResponse
> {
  constructor(redis: Pick<RedisClient, "get" | "set" | "send">) {
    super(redis, {
      prefix: "coforge:reset-credit:v1",
      pendingTtlSeconds: RESET_CREDIT_PENDING_TTL_SECONDS,
      resultTtlSeconds: RESET_CREDIT_RESULT_TTL_SECONDS,
      encode: encodeDaemonRuntimeResetCreditConsumeResponse,
      decode: decodeDaemonRuntimeResetCreditConsumeResponse,
      sameScope: (pending, result) =>
        pending.protocolMajor === result.protocolMajor &&
        pending.requestId === result.requestId &&
        pending.workspaceId === result.workspaceId &&
        pending.computerId === result.computerId &&
        pending.provider === result.provider,
    });
  }
}

let singleton: RedisResetCreditResults | undefined;
export function getResetCreditResults() {
  return (singleton ??= new RedisResetCreditResults(
    openRedisClient(redisUrlFor("Reset credit attempts")),
  ));
}
