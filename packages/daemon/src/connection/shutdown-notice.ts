import { getLogger } from "@logtape/logtape";
import {
  DAEMON_RUNTIME_SHUTDOWN_METHOD,
  diagnosticErrorCode,
  encodeDaemonRuntimeShutdown,
  type DaemonRuntimeShutdown,
} from "@lrm/coforge-sdk/internal";
import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import type { DaemonConnectionTiming } from "./daemon-connection-timing";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "./shutdown-notice-timeout";

const logger = getLogger(["coforge", "daemon", "connection"]);

export async function sendShutdownNoticeOver(
  client: CentrifugeWorkspaceClient | undefined,
  timing: DaemonConnectionTiming,
  notice: DaemonRuntimeShutdown,
): Promise<void> {
  const fields = {
    event: "daemon_connection:shutdown_notice",
    request_id: notice.requestId,
    workspace_id: notice.workspaceId,
    computer_id: notice.computerId,
    reason: notice.reason,
  };
  if (!client) {
    logger.info("Shutdown notice not sent: not connected", {
      ...fields,
      outcome: "unknown",
      error_code: "not_connected",
    });
    return;
  }
  let timer: unknown;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timer = timing.schedule(() => resolve("timed_out"), DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS);
  });
  try {
    const answered = await Promise.race([
      client
        .rpc(DAEMON_RUNTIME_SHUTDOWN_METHOD, encodeDaemonRuntimeShutdown(notice))
        .then(() => "answered" as const),
      timedOut,
    ]);
    if (answered === "answered") logger.info("Shutdown notice sent", { ...fields, outcome: "ok" });
    else
      logger.warning("Shutdown notice got no answer in time", {
        ...fields,
        outcome: "unknown",
        error_code: "timeout",
        duration_ms: DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
      });
  } catch (error) {
    logger.warning("Shutdown notice was not accepted", {
      ...fields,
      outcome: "rejected",
      error_code: diagnosticErrorCode(error),
    });
  } finally {
    timing.cancel(timer);
  }
}
