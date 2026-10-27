import { decodeDaemonRuntimeCommandCodeEffortReadResponse } from "@lrm/coforge-sdk/internal";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import type { RedisCommandCodeEffortResults } from "./command-code-effort-cache.server";
import { getCommandCodeEffortResults } from "./command-code-effort-cache.server";

/** The Computer's reply for one Command Code effort read. Stores it for the waiting form. */
export function createDaemonRuntimeCommandCodeEffortReadResultMethod(
  results?: Pick<RedisCommandCodeEffortResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const response = decodeDaemonRuntimeCommandCodeEffortReadResponse(payload);
    const denied = requireDaemonPrincipal(metadata, response);
    if (denied) return denied;
    if (response.protocolMajor !== 1 || !response.requestId)
      return { code: 400, message: "invalid effort read result" };
    await (results ?? getCommandCodeEffortResults()).accept(response);
    console.info(
      JSON.stringify({
        event: "command_code_effort:read_result",
        request_id: response.requestId,
        workspace_id: response.workspaceId,
        computer_id: response.computerId,
        accepted: response.accepted,
        status: response.status,
        effort_count: response.efforts.length,
        outcome: response.accepted ? "ok" : "failed",
      }),
    );
    return new Uint8Array();
  };
}
