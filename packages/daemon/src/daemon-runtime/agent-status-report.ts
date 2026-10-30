import type { AgentStatus } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentOfflineResidency } from "#src/daemon-runtime/agent-offline-residency";

/** What an Agent status report needs of the runtime: the per-Agent `clientSeq` counter, the
 * residency ledger an `active` report clears, and the transport the report goes out on. */
export type AgentStatusReportPorts = Readonly<{
  agentStatusSequences: Map<string, number>;
  offlineResidency: AgentOfflineResidency;
  transport(): DaemonConnectionClient;
  envelope(): Pick<AgentStatus, "protocolMajor" | "requestId" | "workspaceId" | "computerId">;
  runtimeInstanceId: string;
  startedAtMs: number;
}>;

/** Reports one Agent's `active`/`inactive` status: a monotonically increasing `clientSeq`
 * orders reports the server replays, and an `active` report settles any offline residency. */
export function sendAgentStatus(
  ports: AgentStatusReportPorts,
  agentId: string,
  status: "active" | "inactive",
): void {
  const clientSeq = (ports.agentStatusSequences.get(agentId) ?? 0) + 1;
  ports.agentStatusSequences.set(agentId, clientSeq);
  if (status === "active") ports.offlineResidency.forget(agentId);
  ports.transport().sendAgentStatus?.({
    ...ports.envelope(),
    agentId,
    status,
    daemonInstanceId: ports.runtimeInstanceId,
    clientSeq,
    observedAtMs: ports.startedAtMs,
  });
}
