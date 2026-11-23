import { errorType } from "#src/server/errors/error-type.server";
import type { installerRecoveryRpc } from "./installer-recovery-rpc.server";
import { decodeDaemonRuntimeShutdown, type DaemonRuntimeShutdown } from "@lrm/coforge-sdk/internal";
import type { ComputerLifecycleActivity } from "#src/server/agents/computer-lifecycle-activity.server";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import type { CentrifugoRpcError, CentrifugoRpcMethod } from "./rpc-types.server";

/**
 * A Workspace daemon's notice that it is going down on purpose, and why. Refusals answer like a
 * ready does: 400 for a malformed notice, 403 for another Computer's, 409 for one from a daemon a
 * newer ready already replaced. Each is logged with its stable reason.
 */
export function createDaemonRuntimeShutdownMethod(
  lifecycle: Pick<ComputerLifecycleActivity, "shutdown">,
  currentWorkerInstanceId?: (scope: {
    workspaceId: string;
    computerId: string;
  }) => Promise<string | undefined>,
  closeInstallerRecovery?: ReturnType<typeof installerRecoveryRpc>["close"],
): CentrifugoRpcMethod {
  const refuse = (
    error: CentrifugoRpcError,
    reason: "malformed" | "foreign_computer" | "superseded",
    notice?: DaemonRuntimeShutdown,
  ) => {
    console.warn(
      JSON.stringify({
        event: "daemon_shutdown.rejected",
        outcome: "rejected",
        reason,
        ...(notice
          ? {
              request_id: notice.requestId,
              workspace_id: notice.workspaceId,
              computer_id: notice.computerId,
            }
          : {}),
      }),
    );
    return error;
  };
  return async (payload, metadata) => {
    let notice: DaemonRuntimeShutdown;
    try {
      notice = decodeDaemonRuntimeShutdown(payload);
    } catch {
      return refuse({ code: 400, message: "invalid daemon shutdown notice" }, "malformed");
    }
    const denied = requireDaemonPrincipal(metadata, notice);
    if (denied) return refuse(denied, "foreign_computer", notice);
    const scope = { workspaceId: notice.workspaceId, computerId: notice.computerId };
    try {
      const current = await currentWorkerInstanceId?.(scope);
      if (current && current !== notice.workerInstanceId)
        return refuse(
          { code: 409, message: "daemon runtime was superseded" },
          "superseded",
          notice,
        );
      await lifecycle.shutdown(scope, { requestId: notice.requestId, reason: notice.reason });
      await closeInstallerRecovery?.(notice, metadata).catch(() => {});
      return new Uint8Array();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "daemon_shutdown.record_failed",
          outcome: "failed",
          request_id: notice.requestId,
          workspace_id: notice.workspaceId,
          computer_id: notice.computerId,
          error_type: errorType(error),
        }),
      );
      return { code: 503, message: "daemon shutdown notice was not recorded" };
    }
  };
}
