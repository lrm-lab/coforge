import type { RuntimeMetadata, RuntimeProvider } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { agentStartIntent } from "./manage-agents.server";
import { userAgentControl } from "./user-agent-control.server";

type RecoverableAgent = { stoppedAt?: unknown; deletedAt?: unknown; migrating?: unknown };

export type InventoryAgentRecoveryPorts<Agent extends RecoverableAgent> = {
  failedAgentIds(provider: RuntimeProvider, errorCode: string): Promise<string[]>;
  clearLaunchFailure(agentId: string, errorCode: string): Promise<boolean>;
  agent(agentId: string): Promise<Agent | null | undefined>;
  start(agent: Agent): Promise<void>;
};

/** After inventory lands, restart Agents that failed launch only because the runtime was not
 * reported yet (new Workspace race). `runtime_not_installed` is non-retryable, so without this
 * they stay offline until someone edits the runtime by hand. */
export async function recoverAgentsAfterInventory<Agent extends RecoverableAgent>(
  ports: InventoryAgentRecoveryPorts<Agent>,
  runtimes: readonly RuntimeMetadata[],
): Promise<void> {
  for (const runtime of runtimes) {
    if (runtime.unavailableCode) continue;
    const agentIds = await ports.failedAgentIds(runtime.provider, "runtime_not_installed");
    for (const agentId of agentIds) {
      const cleared = await ports.clearLaunchFailure(agentId, "runtime_not_installed");
      if (!cleared) continue;
      const agent = await ports.agent(agentId);
      if (!agent || agent.stoppedAt || agent.deletedAt || agent.migrating) continue;
      await ports.start(agent).catch(() => {});
    }
  }
}

export function productionInventoryAgentRecovery(
  db: PrismaClient,
  scope: { workspaceId: string; computerId: string },
) {
  const inventory = new PrismaComputerRuntimeRepository(db);
  const control = userAgentControl(db);
  const store = new PrismaAgentControlStore(db);
  return {
    failedAgentIds: (provider: RuntimeProvider, errorCode: string) =>
      inventory.findFailedAgentIdsForRuntime(
        scope.workspaceId,
        scope.computerId,
        provider,
        errorCode,
      ),
    clearLaunchFailure: (agentId: string, errorCode: string) =>
      control.clearLaunchFailure(agentId, errorCode),
    agent: (agentId: string) => store.get(agentId),
    start: async (agent: NonNullable<Awaited<ReturnType<PrismaAgentControlStore["get"]>>>) => {
      await control.recover(agentStartIntent(agent), agent.ownerId);
    },
  };
}
