import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentUsageReportPorts } from "./agent-usage-report";
import { AgentUsageReport } from "./agent-usage-report";

export function assembleUsageReport(
  sessionId: AgentUsageReportPorts["sessionId"],
  envelope: AgentUsageReportPorts["envelope"],
  daemonInstanceId: AgentUsageReportPorts["daemonInstanceId"],
  recordClientSeq: AgentUsageReportPorts["recordClientSeq"],
  transport: () => Pick<
    DaemonConnectionClient,
    "sendAgentContextUsage" | "sendAgentServiceTier" | "sendAgentTokenUsage"
  >,
): AgentUsageReport {
  return new AgentUsageReport({
    sessionId,
    envelope,
    daemonInstanceId,
    recordClientSeq,
    sendContextUsage: (message) => transport().sendAgentContextUsage?.(message),
    sendServiceTier: (message) => transport().sendAgentServiceTier?.(message),
    sendTokenUsage: (message) => transport().sendAgentTokenUsage?.(message),
  });
}
