import { decodeDaemonRuntimeProviderModelRefreshResponse } from "@lrm/coforge-sdk/internal";
import {
  getComputerRuntimeDetection,
  type RedisComputerRuntimeDetection,
} from "#src/server/computers/computer-runtime-detection.server";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import {
  getModelCatalogRefreshResults,
  type RedisModelCatalogRefreshResults,
} from "./model-catalog-refresh-cache.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/**
 * The Daemon's terminal reply for one on-demand model-catalog refresh
 * (`daemon:v1:provider:model_refresh_result`). The fresh catalog itself already landed through the
 * ordinary `daemon:v1:provider:inventory_update` re-report before this reply; this method only
 * authenticates the sender and stores the terminal result for the matching refresh request. It also
 * ends the Computer's detecting of its runtimes for that request, whether or not a page is still
 * asking.
 */
export function createDaemonRuntimeProviderModelRefreshResultMethod(
  results?: Pick<RedisModelCatalogRefreshResults, "accept">,
  detection?: Pick<RedisComputerRuntimeDetection, "end">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const response = decodeDaemonRuntimeProviderModelRefreshResponse(payload);
    const denied = requireDaemonPrincipal(metadata, response);
    if (denied) return denied;
    if (response.protocolMajor !== 1 || !response.requestId)
      return { code: 400, message: "invalid model refresh result" };
    // Ended before the result is stored, so a page that reads the result never finds the Computer
    // still detecting. Only the mark this request set ends, so a reply nothing waits for ends
    // nothing; the mark also expires on its own, so a failure here only delays its end.
    await (detection ?? getComputerRuntimeDetection())
      .end(
        { workspaceId: response.workspaceId, computerId: response.computerId },
        response.requestId,
      )
      .catch(() => {});
    await (results ?? getModelCatalogRefreshResults()).accept(response);
    console.info(
      JSON.stringify({
        event: "code_agent_catalog:refresh_result",
        request_id: response.requestId,
        workspace_id: response.workspaceId,
        computer_id: response.computerId,
        accepted: response.accepted,
        catalog_count: response.results.filter((entry) => entry.status === "refreshed").length,
        failure_count: response.results.filter((entry) => entry.status !== "refreshed").length,
        outcome: response.accepted ? "ok" : "failed",
      }),
    );
    return new Uint8Array();
  };
}
