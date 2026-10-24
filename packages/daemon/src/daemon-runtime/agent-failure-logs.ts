import { getLogger } from "@logtape/logtape";
import type {
  AgentActivityProbe,
  AgentMessageDelivery,
  AgentStartIntent,
  AgentStopIntent,
  AgentWorkspaceResetRequest,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { controlCodeField } from "./control-error-code";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export function logAgentStartFailure(intent: AgentStartIntent, error: unknown): void {
  logger.error("Agent runtime start failed", {
    event: "agent_runtime:start_failed",
    request_id: intent.requestId,
    workspace_id: intent.workspaceId,
    computer_id: intent.computerId,
    agent_id: intent.agentId,
    provider: intent.provider,
    error_code: diagnosticErrorCode(error),
    ...controlCodeField(error),
    outcome: "failed",
  });
}

/** Logs a revoke failure without ever logging the key itself. The failure is recorded and
 * nothing else happens: the server invalidates the key at the Agent's next
 * launch, and the daemon never retries a revoke. */
export function logAgentApiKeyRevokeFailed(agentId: string, error: unknown): void {
  logger.warning("Agent API key revoke failed", {
    event: "agent_api_key:revoke_failed",
    agent_id: agentId,
    error_code: diagnosticErrorCode(error),
    outcome: "failed",
  });
}

export function logAgentActivityProbeFailure(probe: AgentActivityProbe, error: unknown): void {
  logger.error("Agent activity probe failed", {
    event: "agent_activity_probe:failed",
    request_id: probe.requestId,
    workspace_id: probe.workspaceId,
    computer_id: probe.computerId,
    agent_id: probe.agentId,
    probe_id: probe.probeId,
    error_code: diagnosticErrorCode(error),
    outcome: "failed",
  });
}

export function logAgentOperationFailure(
  computerId: string,
  operation: "stop" | "workspace_reset" | "message_delivery",
  request: AgentStopIntent | AgentWorkspaceResetRequest | AgentMessageDelivery,
  error: unknown,
): void {
  logger.warning("Daemon Agent operation failed", {
    event: `agent_runtime:${operation}_failed`,
    request_id: request.requestId,
    workspace_id: request.workspaceId,
    computer_id: computerId,
    agent_id: request.agentId,
    error_code: diagnosticErrorCode(error),
    ...controlCodeField(error),
    outcome: "failed",
  });
}
