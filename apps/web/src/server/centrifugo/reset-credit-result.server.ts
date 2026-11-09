import { decodeDaemonRuntimeResetCreditConsumeResponse } from "@lrm/coforge-sdk/internal";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { getResetCreditResults, type RedisResetCreditResults } from "./reset-credit-cache.server";
import { getUsageCache, type UsageCache } from "./usage-cache.server";
import { decodeUsageSnapshot } from "./usage-snapshot-decode.server";

/**
 * The Computer's answer to one attempt to spend a reset credit
 * (`daemon:v1:provider:reset_credit_consume_result`). The outcome is stored for the page waiting
 * on it. The usage the Computer read afterwards goes to the usage cache the popover reads, before
 * the outcome becomes visible and even when that page has stopped waiting; a reading the server
 * cannot trust, or a cache that fails, is dropped without costing the outcome.
 */
export function createDaemonRuntimeResetCreditConsumeResultMethod(
  dependencies: {
    results?: Pick<RedisResetCreditResults, "accept">;
    usageCache?: Pick<UsageCache, "putResult">;
  } = {},
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const response = decodeDaemonRuntimeResetCreditConsumeResponse(payload);
    const denied = requireDaemonPrincipal(metadata, response);
    if (denied) return denied;
    if (response.protocolMajor !== 1 || !response.requestId || !response.provider)
      return { code: 400, message: "invalid reset credit result" };
    const snapshot = response.snapshotJson
      ? decodeUsageSnapshot(response.snapshotJson, response.provider)
      : undefined;
    const { snapshotJson: _snapshot, ...outcome } = response;
    // The reading first: the page re-reads usage the moment it learns the outcome, so the outcome
    // must not be visible before the usage it comes with. A cache failure never costs the outcome.
    if (snapshot)
      await (dependencies.usageCache ?? getUsageCache())
        .putResult({
          workspaceId: response.workspaceId,
          computerId: response.computerId,
          provider: response.provider,
          scanId: response.requestId,
          status: "available",
          snapshot,
          collectedAt: snapshot.collectedAt ?? new Date().toISOString(),
        })
        .catch(() => undefined);
    await (dependencies.results ?? getResetCreditResults()).accept(outcome);
    console.info(
      JSON.stringify({
        event: "reset_credit:consume_result",
        request_id: response.requestId,
        workspace_id: response.workspaceId,
        computer_id: response.computerId,
        provider: response.provider,
        outcome: response.outcome,
        usage_stored: Boolean(snapshot),
      }),
    );
    return new Uint8Array();
  };
}
