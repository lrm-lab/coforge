import type { DaemonRuntimeUsageScanResponse } from "@lrm/coforge-sdk/internal";
import { getDatabaseClient } from "#src/server/db/client.server";
import {
  resolveAgentUsageTarget,
  type AgentUsageTarget,
} from "#src/server/computers/agent-usage-scope.server";
import { getAgentUsageCache } from "./agent-usage-cache.server";
import type { CentrifugoRpcMetadata } from "./rpc-types.server";
import type { UsageResultRecord } from "./usage-cache.server";

type AgentUsageResultPorts = {
  target(
    scope: Parameters<typeof resolveAgentUsageTarget>[1],
  ): Promise<AgentUsageTarget | undefined>;
  cache(): Pick<ReturnType<typeof getAgentUsageCache>, "complete">;
};

export async function acceptAgentUsageResult(
  response: DaemonRuntimeUsageScanResponse,
  metadata: CentrifugoRpcMetadata,
  reading: UsageResultRecord,
  ports: AgentUsageResultPorts = {
    target: async (scope: Parameters<typeof resolveAgentUsageTarget>[1]) => {
      const db = getDatabaseClient();
      return db ? resolveAgentUsageTarget(db, scope) : undefined;
    },
    cache: getAgentUsageCache,
  },
) {
  const { workerInstanceId, agentId: principalAgent } = metadata.principal;
  const { agentId, effectiveRuntimeConfigRevision } = response;
  if (!workerInstanceId || principalAgent)
    return { code: 403, message: "Agent usage scan worker is not authorized" };
  if (!agentId || effectiveRuntimeConfigRevision === undefined)
    return { code: 400, message: "invalid Agent usage scan scope" };
  const available = reading.status === "available";
  if (available !== response.accepted || available !== !!reading.snapshot)
    return { code: 400, message: "invalid Agent usage scan result" };
  const target = await ports.target({
    workspaceId: response.workspaceId,
    computerId: response.computerId,
    agentId,
    runtimeConfigRevision: effectiveRuntimeConfigRevision,
  });
  if (!target) return { code: 409, message: "Agent usage scan is no longer current" };
  const stored = await ports.cache().complete({ ...target, workerInstanceId }, reading);
  return stored
    ? new Uint8Array()
    : { code: 409, message: "Agent usage scan is no longer current" };
}
