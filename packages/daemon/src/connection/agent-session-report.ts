import { getLogger } from "@logtape/logtape";
import {
  AGENT_SESSION_METHOD,
  diagnosticErrorCode,
  encodeAgentSessionReport,
  refusalText,
  type AgentSessionReport,
} from "@lrm/coforge-sdk/internal";
import { retryTemporaryRpc } from "./temporary-rpc-retry";

const logger = getLogger(["coforge", "daemon", "connection"]);

/** What one session report needs from the connection: the launch identity the daemon observes
 * whether or not the RPC reaches the server, and the RPC itself — re-read per attempt, so a
 * reconnect during a retry is used. */
export type AgentSessionReportPorts = Readonly<{
  observeLaunch(agentId: string, launchId: string): void;
  rpc(method: string, data: Uint8Array): Promise<void>;
}>;

/**
 * Reports one Agent session. A deploy can briefly make the Web container unreachable, and
 * Centrifugo answers the proxied RPC `temporary: true`; that is retried on the bounded backoff
 * rather than reported as a session failure. Whatever remains is logged and thrown.
 */
export async function reportAgentSessionWithRetry(
  ports: AgentSessionReportPorts,
  report: AgentSessionReport,
): Promise<void> {
  ports.observeLaunch(report.agentId, report.launchId);
  const data = encodeAgentSessionReport(report);
  try {
    await retryTemporaryRpc(() => ports.rpc(AGENT_SESSION_METHOD, data));
  } catch (error) {
    logger.error("Agent session report failed", {
      event: "agent_session:report_failed",
      request_id: report.requestId,
      workspace_id: report.workspaceId,
      computer_id: report.computerId,
      agent_id: report.agentId,
      provider: report.provider,
      error_code: diagnosticErrorCode(error),
      error_message: refusalText(error).slice(0, 200),
      outcome: "failed",
    });
    throw error;
  }
}
