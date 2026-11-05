import type { AgentUsageReportPorts } from "./agent-usage-report";
import { AgentUsageReport } from "./agent-usage-report";

/** Assembles the usage report from the runtime's own callbacks, positionally: the runtime file is
 * at its size limit, so its collaborators live here rather than in a named object there. */
export function assembleUsageReport(
  sessionId: AgentUsageReportPorts["sessionId"],
  envelope: AgentUsageReportPorts["envelope"],
  daemonInstanceId: AgentUsageReportPorts["daemonInstanceId"],
  recordClientSeq: AgentUsageReportPorts["recordClientSeq"],
  sendContextUsage: AgentUsageReportPorts["sendContextUsage"],
  sendServiceTier: AgentUsageReportPorts["sendServiceTier"],
): AgentUsageReport {
  return new AgentUsageReport({
    sessionId,
    envelope,
    daemonInstanceId,
    recordClientSeq,
    sendContextUsage,
    sendServiceTier,
  });
}
